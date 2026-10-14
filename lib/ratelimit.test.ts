import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "./httpError";
import {
  clientIp,
  consume,
  enforceIpLimit,
  enforceLimit,
  enforceVisitLimit,
  keyFingerprint,
  limit,
  LIMITS,
  MAX_KEYS,
  memoryStore,
  resetLimits,
  retryAfterSeconds,
  tooManyHeaders,
  tooManyMessage,
  type RateRule,
  type RateVerdict,
} from "./ratelimit";

// T10, design §5.4: limits on the public routes, keyed by IP and by visit.
//
// The windows are tested through `consume`, which takes its clock and its store, so none of this waits on
// real time and none of it needs a server.

const RULE: RateRule = { limit: 3, windowMs: 1_000 };

const headers = (init: Record<string, string>) => new Headers(init);

/** A verdict that refused, for the formatting helpers. */
const refused = (verdict: RateVerdict) => {
  assert.equal(verdict.ok, false, "expected this request to be refused");
  return verdict as Extract<RateVerdict, { ok: false }>;
};

test("a window allows exactly its limit and then refuses", () => {
  const store = memoryStore();
  for (let i = 1; i <= RULE.limit; i++) {
    const verdict = consume(RULE, "ip", "1.2.3.4", 1_000, store);
    assert.equal(verdict.ok, true, `request ${i}`);
    assert.equal(verdict.ok && verdict.remaining, RULE.limit - i);
  }
  const over = refused(consume(RULE, "ip", "1.2.3.4", 1_000, store));
  assert.equal(over.scope, "ip");
  assert.equal(over.limit, 3);
  assert.equal(over.retryAfterMs, 1_000);
});

test("the window reopens when it resets, and not a moment before", () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i++) consume(RULE, "visit", "v1", 0, store);
  // 999 ms in, the first window is still the one being counted.
  assert.equal(consume(RULE, "visit", "v1", 999, store).ok, false);
  // At the reset instant a fresh window opens, and the count starts again.
  const after = consume(RULE, "visit", "v1", 1_000, store);
  assert.equal(after.ok, true);
  assert.equal(after.ok && after.remaining, 2);
});

test("retryAfterMs counts down inside the window", () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i++) consume(RULE, "ip", "1.2.3.4", 0, store);
  assert.equal(refused(consume(RULE, "ip", "1.2.3.4", 0, store)).retryAfterMs, 1_000);
  assert.equal(refused(consume(RULE, "ip", "1.2.3.4", 750, store)).retryAfterMs, 250);
});

test("keys do not share a window: not two scopes, not two keys, not two routes", () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i++) consume(RULE, "ip", "same", 0, store);
  assert.equal(consume(RULE, "ip", "same", 0, store).ok, false);
  // Same key text, other scope.
  assert.equal(consume(RULE, "visit", "same", 0, store).ok, true);
  // Same scope, other key.
  assert.equal(consume(RULE, "ip", "other", 0, store).ok, true);
  // And `limit` puts the route in the key, so one route's flood is not another's.
  for (let i = 0; i < LIMITS.upload.visit.limit + 1; i++) limit("upload", "visit", "v2", 0, store);
  assert.equal(limit("upload", "visit", "v2", 0, store).ok, false);
  assert.equal(limit("sweetie", "visit", "v2", 0, store).ok, true);
});

test("a refused request is still counted, and cannot push the reset away", () => {
  const store = memoryStore();
  for (let i = 0; i < 10; i++) consume(RULE, "ip", "flood", 100, store);
  // Ten tries in, the window still ends where the first request put it.
  assert.equal(refused(consume(RULE, "ip", "flood", 100, store)).retryAfterMs, 1_000);
  assert.equal(consume(RULE, "ip", "flood", 1_100, store).ok, true);
});

test("the store evicts rather than growing without bound", () => {
  const store = memoryStore();
  // Every one of these is its own key, which is what an address-per-request sweep looks like.
  for (let i = 0; i < MAX_KEYS + 500; i++) store.hit(`ip:${i}`, 1_000, 0);
  // The oldest keys went; the newest is still counted, so limiting still works for whoever is here now.
  const newest = store.hit(`ip:${MAX_KEYS + 499}`, 1_000, 0);
  assert.equal(newest.count, 2);
  const oldest = store.hit("ip:0", 1_000, 0);
  assert.equal(oldest.count, 1, "the oldest window should have been evicted");
});

test("eviction prefers windows that have already closed", () => {
  const store = memoryStore();
  const stale = store.hit("ip:stale", 1_000, 0);
  assert.equal(stale.count, 1);
  // Fill to the ceiling at a time by which that first window has closed: with the stale one that is one
  // key too many, which is what triggers the sweep.
  for (let i = 0; i < MAX_KEYS; i++) store.hit(`ip:live-${i}`, 10_000, 5_000);
  // The live windows survived the sweep: the closed one was enough to get back under the ceiling.
  assert.equal(store.hit("ip:live-0", 10_000, 5_000).count, 2);
});

test("reset forgets everything", () => {
  const store = memoryStore();
  for (let i = 0; i < 4; i++) consume(RULE, "ip", "x", 0, store);
  store.reset();
  assert.equal(consume(RULE, "ip", "x", 0, store).ok, true);
});

// ---- What the caller is told -----------------------------------------------------------------------------

test("Retry-After is whole seconds and never zero", () => {
  assert.equal(retryAfterSeconds({ ok: false, scope: "ip", limit: 3, retryAfterMs: 0 }), 1);
  assert.equal(retryAfterSeconds({ ok: false, scope: "ip", limit: 3, retryAfterMs: 1 }), 1);
  assert.equal(retryAfterSeconds({ ok: false, scope: "ip", limit: 3, retryAfterMs: 2_400 }), 3);
  assert.deepEqual(tooManyHeaders({ ok: false, scope: "visit", limit: 3, retryAfterMs: 30_000 }), {
    "Retry-After": "30",
    "Cache-Control": "no-store",
  });
});

test("the message is plain, says how long to wait, and gives the limit away to nobody", () => {
  const soon = tooManyMessage({ ok: false, scope: "visit", limit: 12, retryAfterMs: 24_000 });
  assert.equal(soon, "Too many requests just now. Please wait about 24 seconds and try again.");
  const later = tooManyMessage({ ok: false, scope: "ip", limit: 300, retryAfterMs: 300_000 });
  assert.equal(later, "Too many requests just now. Please wait about 5 minutes and try again.");
  for (const text of [soon, later]) {
    assert.doesNotMatch(text, /12|300|ip|visit/, "the message should not describe the limit that was hit");
  }
});

// ---- The route-handler form ------------------------------------------------------------------------------

test("enforceLimit throws a 429 HttpError once the window is spent, with the headers on it", () => {
  resetLimits();
  const key = `t-${Math.random()}`;
  for (let i = 0; i < LIMITS.verify.visit.limit; i++) enforceVisitLimit("verify", key);
  let caught: unknown;
  try {
    enforceVisitLimit("verify", key);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof HttpError, "the window over the limit should throw an HttpError");
  const thrown = caught;
  assert.equal(thrown.status, 429);
  assert.equal(thrown.event, "rate_limited");
  assert.match(thrown.message, /^Too many requests just now\./);
  assert.equal(thrown.headers["Retry-After"], String(thrown.fields.retryAfter));
  // The log line names the key that was spent and the visit, never an address (§10.3) — and no `route`,
  // which withRoute puts on every line from the request context and a field here would overwrite.
  assert.deepEqual(
    { scope: thrown.fields.scope, limit: thrown.fields.limit, visitId: thrown.fields.visitId },
    { scope: "visit", limit: LIMITS.verify.visit.limit, visitId: key },
  );
  assert.equal(thrown.fields.route, undefined, "the limiter must not overwrite withRoute's own route field");
  // And the body the caller gets carries the header too, which is what a well-behaved client waits on.
  assert.equal(thrown.response().headers.get("retry-after"), String(thrown.fields.retryAfter));
  resetLimits();
});

test("enforceIpLimit keys on the request's forwarded address, and lets the limit through below it", () => {
  resetLimits();
  const req = (ip: string) => new Request("https://sweetspot.health/api/upload", { method: "POST", headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < LIMITS.upload.ip.limit; i++) enforceIpLimit("upload", req("203.0.113.9"));
  assert.throws(() => enforceIpLimit("upload", req("203.0.113.9")), HttpError);
  // Another address is another window, so one flooding host does not take the clinic down with it.
  enforceIpLimit("upload", req("203.0.113.10"));
  resetLimits();
});

test("enforceLimit allows exactly the configured number before refusing", () => {
  resetLimits();
  const key = `t-${Math.random()}`;
  let allowed = 0;
  for (let i = 0; i < LIMITS.sweetie.visit.limit + 5; i++) {
    try {
      enforceLimit("sweetie", "visit", key);
      allowed++;
    } catch {
      break;
    }
  }
  assert.equal(allowed, LIMITS.sweetie.visit.limit);
  resetLimits();
});

// ---- Keys ------------------------------------------------------------------------------------------------

test("the client address comes from the last forwarded hop, which is the one the proxy wrote", () => {
  // A client that invents a hop cannot stop the ALB appending after it: the last entry is the real one, and
  // taking the first would let a caller mint a fresh window per request.
  assert.equal(clientIp(headers({ "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
  assert.equal(clientIp(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" })), "203.0.113.9");
  assert.equal(clientIp(headers({ "x-forwarded-for": "spoofed, ,  203.0.113.9 " })), "203.0.113.9");
  // IPv6 arrives in mixed case from some proxies; one address must not be two windows.
  assert.equal(clientIp(headers({ "x-forwarded-for": "2001:DB8::A" })), "2001:db8::a");
});

test("x-real-ip stands in, and with no proxy header at all everything shares one window", () => {
  assert.equal(clientIp(headers({ "x-real-ip": "203.0.113.4" })), "203.0.113.4");
  assert.equal(clientIp(headers({})), "local");
  // An empty or junk forwarded header is the same case: a shared window, never a window per request.
  assert.equal(clientIp(headers({ "x-forwarded-for": "" })), "local");
  assert.equal(clientIp(headers({ "x-forwarded-for": " , " })), "local");
});

test("a token is fingerprinted, so a patient's live link is never a key", () => {
  const token = "Zm9yd2FyZGVkLWxpbmstdG9rZW4";
  const print = keyFingerprint(token);
  assert.equal(keyFingerprint(token), print, "the same token has to land in the same window");
  assert.notEqual(keyFingerprint(`${token}x`), print);
  assert.doesNotMatch(print, /[A-Z]/);
  assert.equal(token.includes(print), false, "the fingerprint must not be a slice of the token");
  assert.match(keyFingerprint(""), /^[0-9a-z]+$/, "even an empty string gets a key");
});

// ---- The numbers themselves ------------------------------------------------------------------------------

test("every route §5.4 names has both keys, and the visit key is the tighter of the two", () => {
  for (const route of ["link", "verify", "sweetie", "upload"] as const) {
    const limits = LIMITS[route];
    assert.ok(limits.ip.limit > 0 && limits.visit.limit > 0, route);
    assert.ok(limits.visit.limit < limits.ip.limit, `${route}: the per-visit limit is the precise one`);
    for (const rule of [limits.ip, limits.visit]) {
      assert.ok(rule.windowMs >= 1_000 && rule.windowMs <= 3_600_000, `${route}: a window a human can wait out`);
    }
  }
  // The code endpoint is the one a patient uses a handful of times, and is limited accordingly.
  assert.ok(LIMITS.verify.visit.limit < LIMITS.sweetie.visit.limit);
});
