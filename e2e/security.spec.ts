import { expect, test } from "@playwright/test";
import { RUNNER_PORT, RUNNER_SECRET } from "../playwright.config";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";

// Design §10.8: security headers on every response, and CSRF protection on the routes that change
// something. Both claims are checked against the running build, not against the source that sets them.

const CSRF_HEADER = "x-csrf-token";

test("every response carries the §10.8 headers", async ({ request }) => {
  for (const path of ["/", "/api/health"]) {
    const res = await request.get(path);
    const headers = res.headers();
    expect(headers["strict-transport-security"], path).toMatch(/max-age=\d{7,}/);
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["referrer-policy"], path).toBe("no-referrer");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["permissions-policy"], path).toMatch(/camera=\(\)/);
    expect(headers["cross-origin-opener-policy"], path).toBe("same-origin");
  }
});

test("the CSP carries a per-response nonce and no unsafe script source", async ({ request }) => {
  const first = (await request.get("/")).headers()["content-security-policy"];
  const second = (await request.get("/")).headers()["content-security-policy"];
  expect(first).toBeTruthy();
  // Exactly one policy: a second one would be enforced as the intersection of both.
  expect(first.split("content-security-policy").length).toBe(1);
  expect(first).toMatch(/script-src [^;]*'strict-dynamic'/);
  expect(first).toMatch(/frame-ancestors 'none'/);
  expect(first).not.toMatch(/'unsafe-inline'[^;]*;?\s*(?=.*script-src)/);
  expect(first.match(/script-src[^;]*/)![0]).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);

  const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonceOf(first)).toBeTruthy();
  expect(nonceOf(first)).not.toBe(nonceOf(second));
});

test("every page hydrates under the nonce policy, with no CSP violation", async ({ page }) => {
  // The nonce is only worth having if the app still works under it, and the way it fails is quiet: the
  // scripts are refused, the shell renders, and the page simply never fills in. It bit this ticket once
  // already — a statically prerendered page is built before any nonce exists, so its bootstrap scripts come
  // out unsigned and 'strict-dynamic' refuses them. Walking every screen is what catches that, and catches
  // it again the day someone adds a page that opts back out of dynamic rendering.
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });

  // Watching from here means the sign-in screens are covered too: signInAsDemo walks /provider/signin, the
  // form post and the callback (T05, §5.1), which is now the only way into the app. The screenshot is taken
  // before signing in, because afterwards that URL is a redirect to the dashboard.
  await page.goto("/provider/signin");
  await expect(page.getByRole("button", { name: /Email me a link/i })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-security-provider-signin.png`, fullPage: true });

  const demo = await signInAsDemo(page);
  expect(violations, `sign-in: ${violations.join("\n")}`).toEqual([]);

  // page.request, not the bare fixture: /api/book is behind the session and the staff role now (T06, §5.2),
  // and this walk needs the visit, not an unauthenticated POST. The CSRF header is still postJson's job.
  const booked = await (await postJson(page.request, "/api/book", { name: "E2E Csp", providerId: demo.id, visitType: "follow_up", reason: "checking the policy", optIn: false })).json();
  expect(booked.token, "the CSP walk needs a visit to open").toBeTruthy();

  // Each screen, with text that only appears once its client JavaScript has run, and for the intake page the
  // click that reveals the data sources — the Dexcom sandbox button there is the one plain <form> in the app
  // and the only caller that passes its CSRF token in the query string.
  const screens: { name: string; path: string; loaded: RegExp; reveal?: RegExp }[] = [
    { name: "landing", path: "/", loaded: /Sweet Spot|Sweetie/i },
    // The dashboard is behind sign-in now, and it is the screen this walk most needs: the one whose client
    // fetch filling in is the proof of hydration. /demo redirects to the sign-in page with the address
    // filled in, so visiting that would have quietly left the walk looking at a form.
    { name: "provider-dashboard", path: "/provider", loaded: /Sam Sample/ },
    { name: "sweetie", path: `/s/${booked.token}`, loaded: /Hi E2E/ },
    { name: "intake", path: `/s/${booked.token}/intake`, loaded: /Dexcom/i, reveal: /Let.s get started/i },
    { name: "patient-summary", path: `/patient/${booked.token}`, loaded: /Talk to Sweetie/i },
  ];

  for (const screen of screens) {
    await page.goto(screen.path);
    if (screen.reveal) await page.getByRole("button", { name: screen.reveal }).click();
    await expect(page.locator("body"), screen.name).toContainText(screen.loaded, { timeout: 30_000 });
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-security-${screen.name}.png`, fullPage: true });
    expect(violations, `${screen.name}: ${violations.join("\n")}`).toEqual([]);
  }
});

test("a POST with no CSRF token is refused and nothing is created", async ({ request }) => {
  const res = await request.post("/api/book", { data: { name: "E2E Forged", optIn: false } });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe("csrf_failed");
  // The refusal says what was missing, so a real bug is debuggable; it never echoes a token. A request that
  // never saw a page has neither half of the pair, and the cookie is the one checked first.
  expect(body.error).toMatch(/blocked for security reasons/i);
  expect(res.headers()["x-csrf-blocked"]).toMatch(/no ss_csrf cookie/);
  expect(JSON.stringify(res.headers())).not.toContain(CSRF_HEADER.toUpperCase());
});

test("a POST whose token does not match the cookie is refused", async ({ request }) => {
  await csrfToken(request); // take the cookie, then send a different header
  const res = await request.post("/api/book", {
    data: { name: "E2E Mismatch", optIn: false },
    headers: { [CSRF_HEADER]: "A".repeat(43) },
  });
  expect(res.status()).toBe(403);
});

test("a cross-site POST is refused even when it carries the token", async ({ request }) => {
  const token = await csrfToken(request);
  const res = await request.post("/api/book", {
    data: { name: "E2E Cross Site", optIn: false },
    headers: { [CSRF_HEADER]: token, origin: "https://evil.example" },
  });
  expect(res.status()).toBe(403);
  expect(res.headers()["x-csrf-blocked"]).toContain("origin");
});

test("the same POST with the token succeeds, and a GET never needed one", async ({ page }) => {
  // GET /api/provider answers for the session now (§5.1), so this is a safe method that really does something:
  // a 200 with the provider's own row is the proof it was not challenged, where the old ?list=1 fixture only
  // proved an unauthenticated route answered.
  const demo = await signInAsDemo(page);
  const listed = await page.request.get("/api/provider");
  expect(listed.status(), "a safe method is not challenged").toBe(200);
  expect((await listed.json()).id).toBe(demo.id);

  // As the signed-in page: the token is what this asserts, but §5.2 means a POST with a perfect token and no
  // session is a 401, which would say nothing about CSRF either way.
  const res = await postJson(page.request, "/api/book", { name: "E2E Csrf Ok", providerId: demo.id, optIn: false });
  expect(res.status()).toBe(200);
  expect((await res.json()).token).toBeTruthy();
});

// Design §5.1 + §10.8: the other stand-down, and the reason it is not a hole. Auth.js owns everything under
// /api/auth and double-submits its own authjs.csrf-token against a csrfToken form field, so a second
// challenge from our middleware only breaks its client — provider sign-up failed on its last step with
// `x-csrf-blocked: no x-csrf-token header`. e2e/signin.spec.ts walks the whole flow; these three assert that
// the hole is the shape we think it is.
test.describe("Auth.js runs its own CSRF check", () => {
  /** The token Auth.js expects back, and the cookies it set alongside it. */
  async function authCsrfToken(request: import("@playwright/test").APIRequestContext): Promise<string> {
    const res = await request.get("/api/auth/csrf");
    expect(res.ok()).toBeTruthy();
    return (await res.json()).csrfToken as string;
  }

  test("a sign-in POST is not challenged by us, and reaches Auth.js", async ({ request }) => {
    const csrfToken = await authCsrfToken(request);
    const res = await request.post("/api/auth/signin/email", {
      form: { csrfToken, email: "e2e-auth-exempt@example.test", callbackUrl: "/provider" },
      maxRedirects: 0,
    });
    // Auth.js's own answer, not ours: it accepted the request and sent the browser on to its verify page.
    expect(res.headers()["x-csrf-blocked"]).toBeUndefined();
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toContain("verify-request");
  });

  test("a forged Auth.js token is refused by Auth.js", async ({ request }) => {
    await authCsrfToken(request); // take the cookie, then send a token that does not match it
    const res = await request.post("/api/auth/signin/email", {
      form: { csrfToken: "0".repeat(64), email: "e2e-auth-forged@example.test", callbackUrl: "/provider" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toContain("MissingCSRF");
  });

  test("a cross-site sign-in POST is still refused by us", async ({ request }) => {
    const csrfToken = await authCsrfToken(request);
    const res = await request.post("/api/auth/signin/email", {
      form: { csrfToken, email: "e2e-auth-crosssite@example.test", callbackUrl: "/provider" },
      headers: { origin: "https://evil.example" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
    expect(res.headers()["x-csrf-blocked"]).toContain("origin");
  });
});

test("a DELETE is challenged too, not just POST", async ({ request }) => {
  const res = await request.delete("/api/upload", { data: { token: "whatever", kind: "dexcom" } });
  expect(res.status()).toBe(403);
});

// Design §3.4 + §10.8: the one route the CSRF middleware stands down for, and the reasons that is sound.
//
// EventBridge Scheduler posts to /api/jobs/run once a minute with `Authorization: Bearer <JOBS_SECRET>` and
// nothing else — no cookie, no Origin, no page to have read a token from. A CSRF challenge in front of it
// answers 403 before `authorizeRunner` ever runs, and in a deployed environment the queue then never
// drains: no invite texts, no summary emails, no sour.run, no retention sweep. The attack CSRF exists to
// stop needs an *ambient* credential, and this route grants nothing on the strength of a cookie, so there
// is nothing here to ride.
//
// These run against the third server from playwright.config.ts, the only one with a JOBS_SECRET set, which
// is what puts the app in "scheduled" mode and makes the route answer the way production does.
test.describe("the jobs runner is reachable without a CSRF token", () => {
  test.use({ baseURL: `http://localhost:${RUNNER_PORT}` });

  test("no secret is 401 from the route, not 403 from middleware", async ({ request }) => {
    const res = await request.post("/api/jobs/run");
    // The distinction is the whole point: 403 would mean the request never reached authorizeRunner.
    expect(res.status(), await res.text()).toBe(401);
    expect(res.headers()["x-csrf-blocked"]).toBeUndefined();
    expect((await res.json()).code).not.toBe("csrf_failed");
  });

  test("a wrong secret is 401 too", async ({ request }) => {
    const res = await request.post("/api/jobs/run", { headers: { authorization: "Bearer not-the-secret" } });
    expect(res.status()).toBe(401);
    expect(res.headers()["x-csrf-blocked"]).toBeUndefined();
  });

  test("the real secret drains the queue, with no CSRF token anywhere", async ({ request }) => {
    const res = await request.post("/api/jobs/run", { headers: { authorization: `Bearer ${RUNNER_SECRET}` } });
    expect(res.status(), await res.text()).toBe(200);
    // The drain report is what the §11.1 alarm reads, so its shape is part of the contract.
    expect(await res.json()).toHaveProperty("claimed");
  });

  test("the exemption is not a hole: a cross-site post is still refused", async ({ request }) => {
    // Standing down on the token does not stand down on the Origin check, which runs for every request.
    const res = await request.post("/api/jobs/run", {
      headers: { authorization: `Bearer ${RUNNER_SECRET}`, origin: "https://evil.example" },
    });
    expect(res.status()).toBe(403);
    expect(res.headers()["x-csrf-blocked"]).toContain("origin");
  });

  test("a neighbouring path is not exempt", async ({ request }) => {
    // The list is matched exactly, so /api/jobs/<anything else> is challenged like everything else. There is
    // no such route today; a 403 rather than a 404 is the proof that middleware answered first.
    const res = await request.post("/api/jobs/runner-admin");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("csrf_failed");
  });
});
