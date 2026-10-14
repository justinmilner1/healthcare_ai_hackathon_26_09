// Rate limits on the public routes (design §5.4). Owner: compliance.
//
// §5.4: "Rate limits on /api/sweetie, /api/upload, the code endpoints, and the invite link route, keyed by
// IP and by visit." Two keys because they catch two different things, and neither on its own is enough:
//
//   by visit   The precise lock. One visit is one patient's half-hour of intake, so a visit asking for its
//              fortieth six-digit code is not a patient — and this key holds however the caller is connected,
//              through a VPN, a phone and a laptop at once, or a fresh address per request.
//   by IP      The blunt backstop: one host flooding the app, which the per-visit key cannot see because
//              every request names a different visit (a token-enumeration sweep over the link route is
//              exactly that shape). It is deliberately loose. Patients arrive through carrier NAT, where one
//              address can stand for a whole city, and a clinic's waiting room is one address too, so a tight
//              per-IP number would lock out real patients long before it inconvenienced anyone.
//
// Fixed windows, counted in memory. A window is a count and the instant it resets; the first request of a
// window opens it, the one after the limit is refused with the seconds until it closes. The boring choice,
// and the one objection to it — twice the limit across a window boundary — is a factor of two on a number
// already chosen with room to spare. What it is not is a brute-force defence for the codes themselves: three
// wrong tries kill a code and ten minutes kill it anyway (§5.3, lib/patientSession.ts). This is about load.
//
// **In memory means per instance.** Two app servers behind the load balancer each allow the numbers below, so
// the real limit is the number here times the instance count. That is the documented trade (docs/SECURITY.md
// §3): it needs no new dependency, it cannot fail in a way that takes the app down with it, and it is honest
// about being a cost control rather than a security boundary. The production option is to swap the store —
// `RateLimitStore` below is the whole seam, and an ElastiCache (Redis `INCR`/`EXPIRE`) or DynamoDB
// implementation of those two methods is the only code that changes.
//
// Web APIs only, no node:* and no Prisma: middleware.ts imports this for the link route and middleware runs
// on the edge runtime. `consume` is pure given a store and a clock, so the windows are unit-tested without a
// server (lib/ratelimit.test.ts).

import { HttpError } from "./httpError";

/** Which key was spent. The one fact about a refusal worth logging — never the address itself (§10.3). */
export type RateScope = "ip" | "visit";

/** `limit` requests per `windowMs`, per key. */
export type RateRule = { readonly limit: number; readonly windowMs: number };

/** The two keys §5.4 asks for, for one route. */
export type RouteLimits = { readonly ip: RateRule; readonly visit: RateRule };

const MINUTE = 60_000;

/**
 * The limits, per route group named in §5.4.
 *
 * The per-visit numbers are set from what the screen in front of the patient can actually produce: the code
 * screen asks for a code on mount and on each "Send a new code", Sweetie is one message per turn, the intake
 * page is one upload per button. Each is several times the busiest honest run of that screen, so a patient
 * who reloads, re-uploads and retypes never meets one.
 *
 * The per-IP numbers are a flood ceiling, in requests per second: 5/s for the chat and the code screen, 2/s
 * for uploads, which cost the most per request, and 10/s for the link route, where one patient opening one
 * page is already several requests through middleware — the document, the router payloads behind it, and the
 * intake page after it. See the header for why none of them is tighter.
 */
export const LIMITS = {
  /** The invite link route, `/s/<token>` and the intake page under it. Enforced in middleware.ts. */
  link: { ip: { limit: 600, windowMs: MINUTE }, visit: { limit: 60, windowMs: MINUTE } },
  /** The code endpoints: POST /api/verify, both asking for a code and typing one back. */
  verify: { ip: { limit: 300, windowMs: MINUTE }, visit: { limit: 12, windowMs: MINUTE } },
  /** GET and POST /api/sweetie. A POST can cost a model call, which is the expensive thing here. */
  sweetie: { ip: { limit: 300, windowMs: MINUTE }, visit: { limit: 60, windowMs: MINUTE } },
  /** POST and DELETE /api/upload. Up to 20 MB a request (§9.1), so the ceiling is lower. */
  upload: { ip: { limit: 120, windowMs: MINUTE }, visit: { limit: 20, windowMs: MINUTE } },
} as const satisfies Record<string, RouteLimits>;

export type LimitedRoute = keyof typeof LIMITS;

/** One window: how many requests have landed in it, and when it resets. */
export type Window = { count: number; resetAt: number };

/**
 * The seam a deployment replaces (see the header). Two operations, both of which Redis and DynamoDB have:
 * count one request in the window covering `now`, and throw everything away.
 */
export interface RateLimitStore {
  /** Count one request against `key` and return the window it landed in. */
  hit(key: string, windowMs: number, now: number): Window;
  /** Forget every window. For tests and for a store that is being swapped out. */
  reset(): void;
}

/**
 * How many keys one instance will hold. An IP key is minted by whoever connects, so without a ceiling a
 * sweep from a botnet is a memory leak with extra steps. At the ceiling, expired windows go first and then
 * the oldest live ones, which is the right order: a key whose window has closed has nothing left to say, and
 * the oldest live window is the one closest to resetting anyway. 20k windows is a few megabytes.
 */
export const MAX_KEYS = 20_000;

/** How far an eviction cuts back, so the sweep is not re-run on every request once the ceiling is reached. */
const LOW_WATER = Math.floor(MAX_KEYS * 0.9);

export function memoryStore(): RateLimitStore {
  // Insertion-ordered, which is what makes "drop the oldest" a loop rather than a sort.
  const windows = new Map<string, Window>();

  return {
    hit(key, windowMs, now) {
      const current = windows.get(key);
      if (current && current.resetAt > now) {
        current.count += 1;
        return current;
      }
      const fresh: Window = { count: 1, resetAt: now + windowMs };
      // Re-set rather than mutate, so a renewed window moves to the back of the insertion order and the
      // eviction below keeps meaning "oldest first".
      windows.delete(key);
      windows.set(key, fresh);
      if (windows.size > MAX_KEYS) evict(windows, now);
      return fresh;
    },
    reset() {
      windows.clear();
    },
  };
}

function evict(windows: Map<string, Window>, now: number) {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  if (windows.size <= MAX_KEYS) return;
  // Still over: take the oldest down to the low-water mark rather than to the ceiling, so the next request
  // is not another full sweep.
  for (const key of windows.keys()) {
    if (windows.size <= LOW_WATER) break;
    windows.delete(key);
  }
}

/** The process-wide store. One per runtime: middleware's copy lives in the edge isolate and the route
 *  handlers' in the Node one, which is fine — they count different keys and neither is shared anyway. */
const store = memoryStore();

export type RateVerdict =
  | { ok: true; remaining: number }
  | { ok: false; scope: RateScope; limit: number; retryAfterMs: number };

/**
 * Count one request against one rule and say whether it is allowed. Pure given `now` and `into`, which is how
 * the windows are tested. A refused request is still counted: a client that keeps hammering is not thereby
 * given a reason to keep hammering, and a fixed window means the counting cannot push the reset further away.
 */
export function consume(rule: RateRule, scope: RateScope, key: string, now: number = Date.now(), into: RateLimitStore = store): RateVerdict {
  const window = into.hit(`${scope}:${key}`, rule.windowMs, now);
  if (window.count <= rule.limit) return { ok: true, remaining: rule.limit - window.count };
  return { ok: false, scope, limit: rule.limit, retryAfterMs: Math.max(0, window.resetAt - now) };
}

/**
 * The same thing for one of the §5.4 routes: the rule comes from `LIMITS` and the route name goes into the
 * key, so `/api/sweetie` and `/api/upload` never share a window. The one entry point both callers use —
 * middleware.ts for the link route, `enforceLimit` below for everything else.
 */
export function limit(route: LimitedRoute, scope: RateScope, key: string, now: number = Date.now(), into: RateLimitStore = store): RateVerdict {
  return consume(LIMITS[route][scope], scope, `${route}:${key}`, now, into);
}

/** Whole seconds, at least one: what `Retry-After` and the message to the caller both say. */
export function retryAfterSeconds(verdict: Extract<RateVerdict, { ok: false }>): number {
  return Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
}

/**
 * What a refused caller is told. Plain language and no numbers about the limit itself: a patient reading this
 * needs to know that waiting fixes it, and an abuser learns nothing from the shape of the ceiling.
 */
export function tooManyMessage(verdict: Extract<RateVerdict, { ok: false }>): string {
  const seconds = retryAfterSeconds(verdict);
  const wait = seconds <= 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
  return `Too many requests just now. Please wait about ${wait} and try again.`;
}

/** The headers every 429 carries, whoever is sending it. */
export function tooManyHeaders(verdict: Extract<RateVerdict, { ok: false }>): Record<string, string> {
  return { "Retry-After": String(retryAfterSeconds(verdict)), "Cache-Control": "no-store" };
}

/**
 * The route-handler form: count one request and throw the 429 if it is over. `withRoute` turns the throw
 * into the response and into one `rate_limited` log line (lib/log.ts), so a route spends one line on this.
 *
 * `visitId` is passed through to that log line when the key is a visit, because an opaque id is allow-listed
 * and useful: it is how the clinic answers "which visit was that". The IP never is (§10.3).
 */
export function enforceLimit(route: LimitedRoute, scope: RateScope, key: string, fields: Record<string, unknown> = {}): void {
  const verdict = limit(route, scope, key);
  if (verdict.ok) return;
  throw new HttpError(429, tooManyMessage(verdict), "rate_limited", { route, scope, limit: verdict.limit, retryAfter: retryAfterSeconds(verdict), ...fields }, tooManyHeaders(verdict));
}

/** The per-IP half of §5.4 for a route handler. A request with no client address to key on still counts,
 *  under one shared key — see `clientIp`. */
export function enforceIpLimit(route: LimitedRoute, req: Request): void {
  enforceLimit(route, "ip", clientIp(req.headers));
}

/** The per-visit half. Called once the token has named a visit, so a request with an unknown token never
 *  gets a bucket of its own. */
export function enforceVisitLimit(route: LimitedRoute, visitId: string): void {
  enforceLimit(route, "visit", visitId, { visitId });
}

/**
 * Who is calling, as well as this app can know.
 *
 * In production there is exactly one proxy in front — the ALB (§13) — and it appends the address it accepted
 * the connection from to `X-Forwarded-For`. A client can put anything it likes in that header, but it cannot
 * stop the ALB appending after it, so the **last** entry is the one entry nobody but the ALB wrote. Taking the
 * first instead would let a caller mint a fresh bucket per request by typing a new address, which is a rate
 * limiter that limits nothing.
 *
 * With no proxy header at all — `next start` on a laptop, the e2e suite — there is no client address to be
 * had, and inventing one per request would be the same hole. Everything then shares `local`, which is the
 * safe direction to be wrong in: one bucket for all of it, and the per-visit limits still hold.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last.toLowerCase();
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.toLowerCase();
  return "local";
}

/**
 * A short, stable fingerprint of a string, for the one key that is a bearer credential: the invite token in
 * `/s/<token>`. The token names the visit (§5.3) and middleware cannot reach the database to turn it into a
 * visit id, so the token is what the per-visit window is keyed by — and keeping a patient's live link as a
 * map key, where a heap dump or a careless log of the store would find it, is not worth the convenience.
 *
 * FNV-1a, not a hash anyone should rely on for secrecy: it is one-way enough that the key is no longer the
 * credential, and a collision only means two links sharing a window.
 */
export function keyFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // Math.imul keeps the multiply in 32 bits; `*` would lose precision past 2^53.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** For tests: forget every window in the process-wide store. */
export function resetLimits(): void {
  store.reset();
}
