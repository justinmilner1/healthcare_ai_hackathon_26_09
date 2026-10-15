import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CSRF_COOKIE, CSRF_EXEMPT_PATHS, CSRF_EXEMPT_PREFIXES, CSRF_HEADER, CSRF_SELF_CHECKED_PATHS, apiFetch, checkCsrf, checkCsrfRequest, cookieValue, ensureCsrfToken, isCsrfExemptPath, isStateChanging, newCsrfToken, readCsrfToken, type CsrfInput } from "./csrf";

const TOKEN = newCsrfToken();

/** A request as middleware sees it on our own dashboard: same origin, cookie echoed in the header. */
const good = (over: Partial<CsrfInput> = {}): CsrfInput => ({
  method: "POST",
  pathname: "/api/book",
  origin: "https://sweetspot.health",
  referer: null,
  host: "sweetspot.health",
  headerToken: TOKEN,
  cookieToken: TOKEN,
  ...over,
});

test("a token is base64url and long enough to be unguessable", () => {
  const token = newCsrfToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newCsrfToken());
});

test("only unsafe methods are checked", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(isStateChanging(method), false, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) assert.equal(isStateChanging(method), true, method);
});

test("a safe method passes with nothing at all", () => {
  assert.equal(checkCsrf({ method: "GET", pathname: "/api/book", origin: null, referer: null, host: null, headerToken: null, cookieToken: null }), null);
});

test("a same-origin post that echoes the cookie passes", () => {
  assert.equal(checkCsrf(good()), null);
});

test("a cross-site post is refused even when it somehow guessed the token", () => {
  const reason = checkCsrf(good({ origin: "https://evil.example" }));
  assert.equal(reason, "origin does not match host");
});

test("the proxy's view of the host is what the origin is compared against", () => {
  // Behind an ALB, Host is the internal name and x-forwarded-host is what the browser asked for.
  assert.equal(checkCsrf(good({ host: "10.0.3.17:3000", forwardedHost: "sweetspot.health" })), null);
});

test("Referer stands in when there is no Origin", () => {
  assert.equal(checkCsrf(good({ origin: null, referer: "https://sweetspot.health/provider/abc" })), null);
  assert.equal(checkCsrf(good({ origin: null, referer: "https://evil.example/page" })), "origin does not match host");
});

test("an unparsable origin is refused rather than ignored", () => {
  assert.equal(checkCsrf(good({ origin: "not a url" })), "unparsable origin");
});

test("a matching origin is not enough on its own: the token is still required", () => {
  // A same-origin injection, or any caller that can reach the API, still has to have read the cookie.
  assert.equal(checkCsrf(good({ headerToken: null })), `no ${CSRF_HEADER} header`);
  assert.equal(checkCsrf(good({ cookieToken: null })), `no ${CSRF_COOKIE} cookie`);
});

test("a header that does not match the cookie is refused", () => {
  assert.equal(checkCsrf(good({ headerToken: newCsrfToken() })), `${CSRF_HEADER} does not match the ${CSRF_COOKIE} cookie`);
});

test("a token of the wrong shape cannot match itself", () => {
  // Without the shape check, `ss_csrf=x` plus `x-csrf-token: x` would be a valid pair.
  assert.equal(checkCsrf(good({ headerToken: "x", cookieToken: "x" })), "malformed csrf token");
});

test("a no-Origin client (curl, the e2e request fixture) passes on the token alone", () => {
  assert.equal(checkCsrf(good({ origin: null, referer: null })), null);
  assert.equal(checkCsrf(good({ origin: null, referer: null, headerToken: null })), `no ${CSRF_HEADER} header`);
});

test("the query-string token is accepted where a header cannot be set", () => {
  // The sandbox Dexcom button is a plain <form method="POST">; see CSRF_PARAM in ./csrf.
  assert.equal(checkCsrf(good({ headerToken: null, urlToken: TOKEN })), null);
  assert.equal(checkCsrf(good({ headerToken: null, urlToken: newCsrfToken() })), `${CSRF_HEADER} does not match the ${CSRF_COOKIE} cookie`);
});

// --- Exemptions. Each one is a hole by construction, so each is tested for the shape of the hole too.

test("the jobs runner is exempt: its authority is a bearer secret, not a cookie", () => {
  // EventBridge Scheduler posts with Authorization and nothing else (design §3.4). A 403 here would mean
  // the queue never drains in a deployed environment: no invites, no summary emails, no retention sweep.
  assert.equal(checkCsrf(good({ pathname: "/api/jobs/run", origin: null, referer: null, headerToken: null, cookieToken: null })), null);
  // And still exempt when a browser's cookie happens to ride along; authorizeRunner is what guards it.
  assert.equal(checkCsrf(good({ pathname: "/api/jobs/run", origin: null, referer: null, headerToken: null })), null);
});

test("the exemption does not let a cross-site page reach the runner", () => {
  // Step 1 runs for every request, exempt or not, so a forged origin is still refused before the route.
  assert.equal(checkCsrf(good({ pathname: "/api/jobs/run", origin: "https://evil.example" })), "origin does not match host");
});

test("the exempt list is exact, not a prefix", () => {
  // A prefix match would exempt /api/jobs/runner-admin the day someone adds it.
  assert.equal(isCsrfExemptPath("/api/jobs/run"), true);
  assert.equal(isCsrfExemptPath("/api/jobs/run/"), true);
  assert.equal(isCsrfExemptPath("/api/jobs/runner-admin"), false);
  assert.equal(isCsrfExemptPath("/api/jobs/run/extra"), false);
  assert.equal(checkCsrf(good({ pathname: "/api/jobs/runner-admin", headerToken: null })), `no ${CSRF_HEADER} header`);
});

test("Auth.js's own routes are exempt: it runs this same check for itself", () => {
  // signIn() and signOut() in next-auth/react are library code with nowhere to add our header, and Auth.js
  // double-submits its own authjs.csrf-token cookie against a csrfToken form field. Challenging it twice only
  // broke provider sign-up: POST /api/auth/signin/email answered 403 "no x-csrf-token header".
  for (const path of ["/api/auth/signin/email", "/api/auth/signout", "/api/auth/callback/email"]) {
    assert.equal(checkCsrf(good({ pathname: path, headerToken: null })), null, path);
  }
});

test("the auth prefix stops at a path separator", () => {
  assert.equal(isCsrfExemptPath("/api/auth/signin/email"), true);
  // Not "anything starting with /api/auth": a route of our own named like one is still challenged.
  assert.equal(isCsrfExemptPath("/api/authority"), false);
  assert.equal(isCsrfExemptPath("/api/auth"), false);
  assert.equal(checkCsrf(good({ pathname: "/api/authority", headerToken: null })), `no ${CSRF_HEADER} header`);
});

test("the auth exemption does not let a cross-site page sign anyone in", () => {
  assert.equal(checkCsrf(good({ pathname: "/api/auth/signin/email", headerToken: null, origin: "https://evil.example" })), "origin does not match host");
});

test("both exempt lists stay short, and every entry is named", () => {
  // The lists are holes by construction. A new entry should be a decision someone made, not a diff nobody
  // read: this test fails until the person adding one also comes here.
  // `/api/notifications/sns` (T19): SNS posts §8.1's bounces, complaints and STOPs with no cookie and no
  // header we choose, and the route's authority is the signature it checks itself (lib/snsSignature.ts).
  assert.deepEqual([...CSRF_EXEMPT_PATHS], ["/api/jobs/run", "/api/notifications/sns"]);
  assert.deepEqual([...CSRF_EXEMPT_PREFIXES], ["/api/auth/"]);
});

test("a Server Action posts with no header to stamp, so a verified origin stands in", () => {
  // Next posts a Server Action to the page's own URL with Next-Action and the browser's cookies; no
  // application code issues it, so there is nowhere to add x-csrf-token (T05's provider sign-in).
  assert.equal(checkCsrf(good({ pathname: "/provider", serverAction: "7f3a…", headerToken: null })), null);
});

test("a Server Action from another origin is still refused", () => {
  assert.equal(checkCsrf(good({ pathname: "/provider", serverAction: "7f3a…", headerToken: null, origin: "https://evil.example" })), "origin does not match host");
});

test("a Server Action with no origin at all does not get the stand-down", () => {
  // A browser always sends Origin on a Server Action POST, so this shape is not one, and the header alone
  // must not be enough: the whole argument for the exemption is that step 1 verified something.
  assert.equal(
    checkCsrf(good({ pathname: "/provider", serverAction: "7f3a…", headerToken: null, origin: null, referer: null })),
    `no ${CSRF_HEADER} header`,
  );
});

// --- The client half. It runs in the browser, so the globals it reads are stubbed here. These three are
// the only part of the scheme with no other safety net: checkCsrf refuses when they get it wrong, so a bug
// here is a page whose every POST fails, and the e2e suite reaches them only through a real browser.

/** Install a writable `document.cookie` that behaves like the real one: assigning a `k=v; attrs` string
 *  adds or replaces that one cookie, and reading gives back `k=v; k2=v2`. */
function stubDocument(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const document = {
    get cookie(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(assignment: string) {
      const [pair] = assignment.split(";");
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    },
  };
  const globals = globalThis as Record<string, unknown>;
  const had = "document" in globals;
  const previous = globals.document;
  globals.document = document;
  const restore = () => {
    if (had) globals.document = previous;
    else delete globals.document;
  };
  return { jar, restore };
}

async function withDocument<T>(initial: Record<string, string>, fn: (jar: Map<string, string>) => T | Promise<T>): Promise<T> {
  const stub = stubDocument(initial);
  try {
    return await fn(stub.jar);
  } finally {
    stub.restore();
  }
}

test("readCsrfToken reads the cookie out of a crowded jar", async () => {
  await withDocument({ other: "x", ss_csrf: TOKEN, "authjs.session-token": "cxyz" }, () => {
    assert.equal(readCsrfToken(), TOKEN);
  });
});

test("readCsrfToken returns null rather than a value checkCsrf would refuse", async () => {
  await withDocument({}, () => assert.equal(readCsrfToken(), null));
  // A hand-set cookie of the wrong shape is not a token; returning it would make apiFetch send a header
  // that cannot match, which is a confusing 403 instead of a fresh one that works.
  await withDocument({ ss_csrf: "short" }, () => assert.equal(readCsrfToken(), null));
});

test("ensureCsrfToken returns the cookie it already has, unchanged", async () => {
  await withDocument({ ss_csrf: TOKEN }, (jar) => {
    assert.equal(ensureCsrfToken(), TOKEN);
    assert.equal(jar.get("ss_csrf"), TOKEN);
  });
});

test("ensureCsrfToken mints and stores one when the cookie is missing", async () => {
  // The page restored from a cache older than the cookie. Minting is sound because double submit only
  // needs the two halves to agree, and the cookie it writes is the half checkCsrf will compare against.
  await withDocument({}, (jar) => {
    const minted = ensureCsrfToken();
    assert.equal(jar.get("ss_csrf"), minted);
    assert.equal(
      checkCsrf(good({ headerToken: minted, cookieToken: jar.get("ss_csrf") ?? null })),
      null,
      "a minted token must satisfy the server's own check",
    );
  });
});

test("ensureCsrfToken replaces a malformed cookie instead of echoing it back", async () => {
  await withDocument({ ss_csrf: "short" }, (jar) => {
    const minted = ensureCsrfToken();
    assert.notEqual(minted, "short");
    assert.equal(jar.get("ss_csrf"), minted);
  });
});

test("apiFetch sends the token on an unsafe method and leaves a safe one alone", async () => {
  await withDocument({ ss_csrf: TOKEN }, async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const globals = globalThis as Record<string, unknown>;
    const realFetch = globals.fetch;
    globals.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), headers: new Headers(init.headers) });
      return Promise.resolve(new Response("{}"));
    };
    try {
      await apiFetch("/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await apiFetch("/api/provider");
      await apiFetch("/api/upload", { method: "DELETE" });
    } finally {
      globals.fetch = realFetch;
    }
    assert.equal(seen[0].headers.get(CSRF_HEADER), TOKEN);
    // The caller's own headers survive: dropping Content-Type would turn every JSON post into a 400.
    assert.equal(seen[0].headers.get("Content-Type"), "application/json");
    assert.equal(seen[1].headers.get(CSRF_HEADER), null, "a GET is not challenged, so it carries nothing");
    assert.equal(seen[2].headers.get(CSRF_HEADER), TOKEN, "a DELETE is as unsafe as a POST");
  });
});

// --- The self-checked routes (CSRF_SELF_CHECKED_PATHS) ----------------------------------------------
// /api/upload runs this check inside the handler because middleware cannot carry its body (§9.1's 20 MB).
// Review: these three cover the two functions that move it there, which nothing but the e2e suite reached.

test("checkCsrfRequest reads a whole Request the same way middleware reads its parts", () => {
  const req = (init: { headers?: Record<string, string>; url?: string; method?: string } = {}) =>
    new Request(init.url ?? "https://sweetspot.health/api/upload", { method: init.method ?? "POST", headers: init.headers });

  assert.equal(
    checkCsrfRequest(req({ headers: { origin: "https://sweetspot.health", host: "sweetspot.health", cookie: `${CSRF_COOKIE}=${TOKEN}`, [CSRF_HEADER]: TOKEN } })),
    null,
  );
  assert.equal(
    checkCsrfRequest(req({ headers: { origin: "https://evil.example", host: "sweetspot.health", cookie: `${CSRF_COOKIE}=${TOKEN}`, [CSRF_HEADER]: TOKEN } })),
    "origin does not match host",
  );
  assert.equal(
    checkCsrfRequest(req({ headers: { origin: "https://sweetspot.health", host: "sweetspot.health", cookie: `${CSRF_COOKIE}=${TOKEN}` } })),
    `no ${CSRF_HEADER} header`,
  );
  // The token may ride in the query string here too, exactly as it may through middleware.
  assert.equal(
    checkCsrfRequest(req({ url: `https://sweetspot.health/api/upload?csrf=${TOKEN}`, headers: { origin: "https://sweetspot.health", host: "sweetspot.health", cookie: `${CSRF_COOKIE}=${TOKEN}` } })),
    null,
  );
  // A safe method is not challenged, so no cookie and no header is fine.
  assert.equal(checkCsrfRequest(req({ method: "GET", headers: { host: "sweetspot.health" } })), null);
});

test("cookieValue picks the right cookie out of a header and never throws on one it cannot decode", () => {
  assert.equal(cookieValue(null, CSRF_COOKIE), null);
  assert.equal(cookieValue("", CSRF_COOKIE), null);
  assert.equal(cookieValue("other=1", CSRF_COOKIE), null);
  assert.equal(cookieValue(`${CSRF_COOKIE}=${TOKEN}`, CSRF_COOKIE), TOKEN);
  // Order and spacing are the browser's, not ours.
  assert.equal(cookieValue(`a=1; ${CSRF_COOKIE}=${TOKEN}; z=2`, CSRF_COOKIE), TOKEN);
  assert.equal(cookieValue(`a=1;${CSRF_COOKIE}=${TOKEN}`, CSRF_COOKIE), TOKEN);
  // A name that merely ends with ours is a different cookie; matching it would be a way in.
  assert.equal(cookieValue(`not_${CSRF_COOKIE}=decoy; ${CSRF_COOKIE}=${TOKEN}`, CSRF_COOKIE), TOKEN);
  // A value may contain '=' (base64 padding), so only the first one separates name from value.
  assert.equal(cookieValue(`${CSRF_COOKIE}=a=b`, CSRF_COOKIE), "a=b");
  // The header is whatever the caller typed. '%ZZ' makes decodeURIComponent throw; the undecoded value
  // comes back instead so checkCsrf can refuse it with 403 rather than the route failing with a 500.
  assert.equal(cookieValue(`${CSRF_COOKIE}=%ZZ`, CSRF_COOKIE), "%ZZ");
  assert.equal(checkCsrf(good({ cookieToken: "%ZZ", headerToken: "%ZZ" })), "malformed csrf token");
});

test("every self-checked path is actually left out of middleware's matcher", () => {
  // The two have to agree: a path in this list that middleware still matches is an upload that breaks at
  // 10 MB again, and a path dropped from the matcher that is not in this list is an unchecked route.
  const middleware = readFileSync(path.join(import.meta.dirname, "..", "middleware.ts"), "utf8");
  const matcher = middleware.match(/matcher:\s*\[([^\]]*)\]/)?.[1];
  assert.ok(matcher, "middleware.ts must declare a matcher");
  for (const p of CSRF_SELF_CHECKED_PATHS) {
    assert.ok(matcher.includes(p.replace(/^\//, "")), `${p} is self-checked but middleware still matches it`);
    // And it is self-checked, not exempt: the two lists must stay disjoint.
    assert.equal(isCsrfExemptPath(p), false, `${p} cannot be both self-checked and exempt`);
  }
});
