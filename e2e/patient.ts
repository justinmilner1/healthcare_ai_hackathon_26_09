import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { postJson } from "./api";
import { MAIL_DIR } from "./auth";

// Verifying a patient link the way a patient does (design §2.3, §5.3): open the link, read the six-digit
// code out of the message that was "sent", type it in. Nothing is stubbed — with no SMS or email backend
// configured, lib/mailer.ts drops the code in DEV_MAIL_DIR instead of sending it (the console mailer the
// ticket's acceptance criteria name), and these helpers read it back out of there.
//
// One mailbox per server, because playwright.config.ts starts three of them and a code from one must never
// be read as another's. MAIL_DIR and DEGRADED_MAIL_DIR come from e2e/auth.ts, which already names them for
// the sign-in links; a code and a sign-in link land in the same directory.

/**
 * Every patient these specs book needs a contact method, because that is where the code goes — and a
 * different one each time. The address is the key the mailbox is searched by, and the desktop and mobile
 * projects run every spec against the same database and the same mailbox: two bookings sharing an address
 * put two visits' codes under one name, and "the newest code for this address" then belongs to whichever
 * project got there second. Call it once per booking and pass the result around.
 */
export const patientEmail = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${randomBytes(4).toString("hex")}@example.test`;

/** The newest code sent to this address, or null while nothing has arrived. */
export function latestCode(email: string, dir = MAIL_DIR): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
  } catch {
    return null;
  }
  const to = `To: ${email}`;
  for (const name of names.reverse()) {
    const raw = readFileSync(join(dir, name), "utf8");
    if (!raw.split("\n").includes(to)) continue;
    // The subject is "Your code is 480913" (lib/notify.ts codeTemplates), which is also the only place in
    // the mailbox a bare six-digit number appears.
    const code = raw.match(/^Subject: Your code is (\d{6})$/m)?.[1];
    if (code) return code;
  }
  return null;
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
  for (let attempt = 0; attempt < 60; attempt++) {
    const code = latestCode(email, dir);
    if (code && code !== notBefore) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no verification code arrived for ${email} in ${dir}`);
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
  await expect(field).toBeVisible({ timeout: 30_000 });
  const code = await waitForCode(email, dir, notBefore);
  await field.fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  // The gate is a server component, so a verified link is a navigation away from the code screen.
  await expect(field).toBeHidden({ timeout: 30_000 });
  return code;
}

/** The one tap on the consent screen (design §2.4, T09). */
export const AGREE = /I agree/i;

/**
 * Take the consent screen, if this visit has not been past it yet (§2.4 is first open only, so the second
 * verification of the same visit — a regenerated link, another device — goes straight through). Returns
 * whether there was a screen to take, so a spec can assert on either.
 *
 * The screen is server-rendered by the gate, so it is in the document the moment the code screen goes: the
 * short wait is for the parse of that document, not for app logic.
 */
export async function acceptConsent(page: Page): Promise<boolean> {
  const agree = page.getByRole("button", { name: AGREE });
  await page.waitForLoadState("domcontentloaded");
  try {
    await agree.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return false;
  }
  // Accepting reloads through the gate, and the wait for that reload is armed *before* the click, not after.
  // The obvious "wait for the button to go" is a trap: the button renames itself to "One moment…" while the
  // POST is in flight, so a locator that matches it by name stops matching before the navigation has even
  // started — and the spec's next goto then cancels the reload, which Playwright reports as ERR_ABORTED on
  // that goto, several lines from the cause.
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 30_000 });
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
 */
export async function verifyByApi(request: APIRequestContext, token: string, email: string, dir = MAIL_DIR): Promise<string> {
  const before = latestCode(email, dir);
  const asked = await postJson(request, "/api/verify", { token });
  expect(asked.status(), `POST /api/verify: ${await asked.text()}`).toBe(202);
  const code = await waitForCode(email, dir, before);
  const verified = await postJson(request, "/api/verify", { token, code });
  expect(verified.status(), `POST /api/verify with the code: ${await verified.text()}`).toBe(200);
  const consented = await postJson(request, "/api/consent", { token, accept: true });
  expect(consented.status(), `POST /api/consent: ${await consented.text()}`).toBe(200);
  return code;
}
