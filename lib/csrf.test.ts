import assert from "node:assert/strict";
import test from "node:test";
import { CSRF_COOKIE, CSRF_EXEMPT_PATHS, CSRF_HEADER, apiFetch, checkCsrf, ensureCsrfToken, isCsrfExemptPath, isStateChanging, newCsrfToken, readCsrfToken, type CsrfInput } from "./csrf";

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

test("every exempt path is one this app actually serves", () => {
  // Cheap guard against a typo leaving a dead entry, and against the list growing unnoticed.
  assert.deepEqual([...CSRF_EXEMPT_PATHS], ["/api/jobs/run"]);
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
  await withDocument({ other: "x", ss_csrf: TOKEN, ss_provider: "cxyz" }, () => {
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
      await apiFetch("/api/provider?list=1");
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
