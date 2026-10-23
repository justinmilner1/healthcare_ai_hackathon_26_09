import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { findDevMail } from "../lib/devMailbox";
import { postJson } from "./api";
import { MAIL_DIR } from "./auth";
import { LOADED, LOADED_TIMEOUT_MS } from "./budget";

// Verifying a patient link the way a patient does (design §2.3, §5.3): open the link, read the six-digit
// code out of the message that was "sent", type it in. Nothing is stubbed — with no SMS or email backend
// configured, lib/mailer.ts drops the code in DEV_MAIL_DIR instead of sending it (the console mailer the
// ticket's acceptance criteria name), and these helpers read it back out of there.
//
// playwright.config.ts starts four servers with a mailbox each, and a code goes in whichever one drains the
// `notify.code` job — see latestCode, which is why these read all of them and e2e/auth.ts's sign-in links do
// not. MAIL_DIR comes from e2e/auth.ts, which already names it for those links.

/**
 * Every patient these specs book needs a contact method, because that is where the code goes — and a
 * different one each time. The address is the key the mailbox is searched by, and the desktop and mobile
 * projects run every spec against the same database and the same mailbox: two bookings sharing an address
 * put two visits' codes under one name, and "the newest code for this address" then belongs to whichever
 * project got there second. Call it once per booking and pass the result around.
 */
export const patientEmail = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${randomBytes(4).toString("hex")}@example.test`;

/**
 * Every mailbox the suite's servers write to, newest file first across all of them.
 *
 * A code is not written by the server the patient is talking to: POST /api/verify enqueues a `notify.code`
 * job, and the servers share one database, so whichever of them next drains inline is the one that sends it
 * — and it writes to *its* mailbox. Looking only in the main one loses roughly one code in fifty to the
 * degraded server's box, as a timeout fifteen seconds later with nothing to show for it.
 *
 * Searching all of them is safe because every booking gets its own address (patientEmail), so a code found
 * under one is unambiguously this patient's. Sign-in links are the opposite case and stay per-mailbox in
 * e2e/auth.ts: those all go to the one demo address, so only the directory tells them apart.
 */
const MAIL_DIRS = (first: string) =>
  [...new Set([first, MAIL_DIR, `${MAIL_DIR}-degraded`, `${MAIL_DIR}-runner`, `${MAIL_DIR}-dexcom`])];

/**
 * The newest code sent to this address, or null while nothing has arrived.
 *
 * The walk is lib/devMailbox.ts's findDevMail, newest file first across every box, because these boxes are
 * shared with the sign-in links e2e/auth.ts claims by renaming: a read of a listed name can find the file
 * already gone, and a code this spec is waiting for must not be lost to an ENOENT over somebody else's mail
 * (T65). findDevMail skips what it cannot read, so waitForCode's retry loop gets to go round again.
 */
export function latestCode(email: string, dir = MAIL_DIR): string | null {
  // The subject is "Your code is 480913" (lib/notify.ts codeTemplates), which is also the only place in the
  // mailbox a bare six-digit number appears.
  return findDevMail(MAIL_DIRS(dir), email, (raw) => raw.match(/^Subject: Your code is (\d{6})$/m)?.[1] ?? null);
}

/**
 * Wait for the code: POST /api/verify answers 202 and the `notify.code` job sends after the response.
 *
 * `notBefore` is for a resend, where the point is that the *next* code arrives. It is not the default,
 * because reopening a link reuses a code that is still live rather than minting a second one (§5.3) — so
 * insisting on a different one there would wait for something that is never coming. Every spec books its
 * patient with its own address, which is what keeps "the newest code for this address" unambiguous.
 */
export async function waitForCode(email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  // A deadline off the suite's shared budget rather than a count of attempts (T95, e2e/budget.ts): sixty of
  // them was fifteen seconds of a wait on the `notify.code` job draining, with no way of being raised.
  const deadline = Date.now() + LOADED_TIMEOUT_MS;
  for (;;) {
    const code = latestCode(email, dir);
    if (code && code !== notBefore) return code;
    if (Date.now() >= deadline) throw new Error(`no verification code arrived for ${email} in ${dir} within ${LOADED_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Type the code on a code screen that is already showing, and wait for the page behind it.
 *
 * `notBefore` is the code this address was last sent, for a test that verifies the same patient twice — a
 * regenerated link (§5.5) sends a second code to the same address, and the first one is still the newest
 * file in the mailbox until it lands. Without it the screen gets the old code and stays where it is.
 */
export async function enterCode(page: Page, email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  const field = page.getByLabel("6-digit code");
  await expect(field).toBeVisible(LOADED);
  const code = await waitForCode(email, dir, notBefore);
  await field.fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  // The gate is a server component, so a verified link is a navigation away from the code screen.
  await expect(field).toBeHidden(LOADED);
  return code;
}

/** The one tap on the consent screen (design §2.4, T09). */
export const AGREE = /I agree/i;

/**
 * The eyebrow over the patient summary's hero (design §2.7, T123).
 *
 * Three specs assert it — one per state the page has, which is the point of it: it is read off
 * `stats.days` through spanNoun() like the three strings below it, so a single-day upload, a week and a
 * visit with nothing shared each get a different line and no two of them may drift apart. Shared here
 * rather than spelled out three times because the selector is the thing that would drift: the eyebrow is
 * in `.patient-summary-hero`, which is outside the `.patient-summary-content` the span assertions in
 * e2e/flows.spec.ts sweep, and that is how it stayed literal through T100 and T114.
 */
export const EYEBROW = (page: Page) => page.locator(".patient-summary-hero .ss-eyebrow");

/**
 * Take the consent screen, if this visit has not been past it yet (§2.4 is first open only, so the second
 * verification of the same visit — a regenerated link, another device — goes straight through). Returns
 * whether there was a screen to take, so a spec can assert on either.
 *
 * The screen is server-rendered by the gate, so it is in the document the moment the code screen goes: the
 * short wait is for the parse of that document, not for app logic.
 *
 * The one wait in the suite that does not take the shared budget (T95, e2e/budget.ts), because expiring is
 * one of its two answers rather than a failure: the caller before this line has already awaited
 * `domcontentloaded`, so the button is in the parsed document or it is not, and nothing asynchronous is on
 * its way. Taking 30s here would add 30s to every verification of a visit that is already past consent.
 */
export async function acceptConsent(page: Page): Promise<boolean> {
  const agree = page.getByRole("button", { name: AGREE });
  await page.waitForLoadState("domcontentloaded");
  try {
    // eslint-disable-next-line no-restricted-syntax -- see above: expiring here is an answer, not a slow box
    await agree.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return false;
  }
  // Accepting reloads through the gate, and the wait for that reload is armed *before* the click, not after.
  // The obvious "wait for the button to go" is a trap: the button renames itself to "One moment…" while the
  // POST is in flight, so a locator that matches it by name stops matching before the navigation has even
  // started — and the spec's next goto then cancels the reload, which Playwright reports as ERR_ABORTED on
  // that goto, several lines from the cause.
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), ...LOADED });
  await agree.click();
  await navigated;
  await page.waitForLoadState("load");
  return true;
}

/**
 * Verify in the browser the way a patient does: open the link, which is what sends the code, type it, and
 * take the consent screen behind it (§2.4). Leaves the page on whatever the link opens, with the session
 * cookie in the browser's jar.
 *
 * The consent tap is in here rather than in every spec because it is now part of opening a link, not a
 * feature any of them are about — e2e/consent.spec.ts is the one that drives the screen itself, and it uses
 * `enterCode` so it arrives with the screen still up.
 */
export async function verifyLink(page: Page, token: string, email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  await page.goto(`/s/${token}`);
  const code = await enterCode(page, email, dir, notBefore);
  await acceptConsent(page);
  return code;
}

/**
 * The same thing for a bare request context, for the specs that read the API directly. The cookie lands in
 * that context's jar, so its later GETs speak as the verified patient. Consent is answered here too, for the
 * same reason as above: a context that has verified is a patient who got through the door, and POST
 * /api/consent is behind the same verified session.
 *
 * `consent: false` stops at the verified session and leaves the screen unanswered, for a spec that is about
 * the answer itself: accepting here would be the row it then goes looking for (e2e/audit.spec.ts, T51).
 */
export async function verifyByApi(
  request: APIRequestContext,
  token: string,
  email: string,
  dir = MAIL_DIR,
  { consent = true }: { consent?: boolean } = {},
): Promise<string> {
  const before = latestCode(email, dir);
  const asked = await postJson(request, "/api/verify", { token });
  expect(asked.status(), `POST /api/verify: ${await asked.text()}`).toBe(202);
  const code = await waitForCode(email, dir, before);
  const verified = await postJson(request, "/api/verify", { token, code });
  expect(verified.status(), `POST /api/verify with the code: ${await verified.text()}`).toBe(200);
  if (!consent) return code;
  const consented = await postJson(request, "/api/consent", { token, accept: true });
  expect(consented.status(), `POST /api/consent: ${await consented.text()}`).toBe(200);
  return code;
}

/** A lat/long pair as lib/location.ts writes one. Nothing on §2.7's page may read like this (T128). */
const COORDINATES = /-?\d+\.\d{3}, -?\d+\.\d{3}/;

/**
 * No coordinates anywhere on the patient's own summary (T128, design §2.7).
 *
 * `placeLabel` is how an unnamed Timeline stop is named for the clinician's brief and the printed sheet
 * (T62), and it used to reach the patient through two surfaces at once: the Where column and the chart's
 * marker labels. So this sweeps the whole of `.patient-summary-content`, which holds both — a third surface
 * growing its own copy of the same string fails here rather than in a reviewer's sweep.
 *
 * The chart is the half that has to be waited for: its labels are painted client-side once the card has
 * been measured, and a chart that has not drawn yet would pass a negative assertion without having drawn
 * anything. The spike markers appear in that same render and are the only circles in the card — the line
 * carries no dots — so one of them on the page is the whole wait.
 */
export async function expectNoCoordinates(page: Page, where: string): Promise<void> {
  await expect(page.locator(".patient-chart-wrap circle"), `the chart's spike markers on ${where}`).not.toHaveCount(0, LOADED);
  await expect(page.locator(".patient-summary-content"), `a lat/long on ${where}`).not.toContainText(COORDINATES);
}
