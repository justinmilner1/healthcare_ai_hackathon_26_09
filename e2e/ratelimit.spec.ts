import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { patientEmail } from "./patient";

// T10, design §5.4: limits on the public routes, keyed by IP and by visit.
//
// The per-visit key is what these drive, for two reasons. It is the limit a patient could actually meet, so
// it is the one whose message has to read well — and it is keyed by visit, so a burst in one test is one
// visit's window and not the whole suite's: every test here books its own patient. The per-IP ceiling is a
// flood number in requests per second (lib/ratelimit.ts), and tripping it on purpose would take the rest of
// the suite's traffic down with it.
//
// Nothing is stubbed. The limits are the shipped ones; what the test does is ask for more codes than any
// patient would.

const LOADED = { timeout: 30_000 };

/** Booking is staff's job and needs their session (T06, §5.2): someone signs in, books, and signs out, which
 *  leaves the browser as a patient's — which is the only side these tests are about. */
async function book(page: Page, name: string) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", { name, email, visitType: "follow_up", reason: "asking too often", channel: "none" })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, visitId: booked.visitId as string, email };
}

test("too many code requests for one visit are refused with a plain message (§5.4)", async ({ page }) => {
  const { token } = await book(page, "E2E Rate Limited");

  // Asking for a code is the cheapest thing a public route does and the most abusable: every one of these is
  // a text or an email at the patient's expense. Twenty-five tries is far past anything a patient does.
  let refused: APIResponse | null = null;
  for (let i = 0; i < 25 && !refused; i++) {
    const res = await postJson(page.request, "/api/verify", { token });
    if (res.status() === 429) refused = res;
    else expect(res.status(), `POST /api/verify #${i + 1}: ${await res.text()}`).toBe(202);
  }
  expect(refused, "the code endpoint should refuse a burst against one visit").toBeTruthy();

  // What a refused caller gets: a 429, the seconds to wait in a header a client can act on, and a sentence
  // with no numbers about the limit in it.
  const retryAfter = Number(refused!.headers()["retry-after"]);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  const body = await refused!.json();
  expect(body.error).toMatch(/too many requests/i);
  expect(body.error).toMatch(/try again/i);

  // And the same sentence on the screen the patient is looking at: the code screen asks for a code on mount,
  // so a reload while the window is spent shows the refusal rather than a dead form (§5.3, VerifyScreen).
  await page.goto(`/s/${token}`);
  await expect(page.locator(".patient-verify-card .ss-error")).toContainText(/too many requests/i, LOADED);
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-ratelimit-verify.png`, fullPage: true });
});

test("one visit's spent window is not another visit's (§5.4)", async ({ page, browser }) => {
  const { token } = await book(page, "E2E Rate Noisy");
  // Spend the noisy visit's window.
  for (let i = 0; i < 25; i++) {
    const res = await postJson(page.request, "/api/verify", { token });
    if (res.status() === 429) break;
  }
  expect((await postJson(page.request, "/api/verify", { token })).status()).toBe(429);

  // A second patient, in a browser of their own, is unaffected: the window is the visit's, and the per-IP
  // ceiling above it is a flood number this is nowhere near.
  const other = await browser.newPage();
  const quiet = await book(other, "E2E Rate Quiet");
  expect((await postJson(other.request, "/api/verify", { token: quiet.token })).status()).toBe(202);
  await other.goto(`/s/${quiet.token}`);
  await expect(other.getByLabel("6-digit code")).toBeVisible(LOADED);
  await other.close();
});

test("the invite link route is limited too, and says so in a page a browser can read (§5.4)", async ({ page, request }) => {
  const { token } = await book(page, "E2E Rate Link");

  // The link route is a page, so its limit lives in middleware (there is no handler to put it in) and is
  // keyed by the token, which names the visit. 60 a minute is far more than opening a link and reloading it.
  let refused: APIResponse | null = null;
  for (let i = 0; i < 70 && !refused; i++) {
    const res = await request.get(`/s/${token}`);
    if (res.status() === 429) refused = res;
  }
  expect(refused, "the link route should refuse a burst against one token").toBeTruthy();
  expect(Number(refused!.headers()["retry-after"])).toBeGreaterThan(0);
  // HTML, not JSON: whoever is reading this typed a link into a browser.
  expect(refused!.headers()["content-type"]).toMatch(/text\/html/);
  const html = await refused!.text();
  expect(html).toMatch(/too many requests/i);
  // The refusal is still a response from this app, so it carries the §10.8 headers like any other.
  expect(refused!.headers()["x-frame-options"]).toBe("DENY");
  expect(refused!.headers()["referrer-policy"]).toBe("no-referrer");
  // Nothing about the patient behind the token leaks into it.
  expect(html).not.toContain(token);
  expect(html).not.toMatch(/E2E Rate Link/);
});
