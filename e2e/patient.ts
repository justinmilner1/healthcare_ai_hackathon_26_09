import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { postJson } from "./api";

// Verifying a patient link the way a patient does (design §2.3, §5.3): open the link, read the six-digit
// code out of the message that was "sent", type it in. Nothing is stubbed — with no SMS or email backend
// configured, lib/mailer.ts drops the code in DEV_MAIL_DIR instead of sending it (the console mailer the
// ticket's acceptance criteria name), and these helpers read it back out of there.
//
// One mailbox per server, because playwright.config.ts starts three of them and a code from one must never
// be read as another's. MAIL_DIR is the main server's; the degraded spec passes its own.

export const MAIL_DIR = process.env.DEV_MAIL_DIR ?? "e2e/.mail";

/** Every patient these specs book needs a contact method, because that is where the code goes. */
export const patientEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.test`;

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

/** Wait for the code: POST /api/verify answers 202 and the `notify.code` job sends after the response. */
export async function waitForCode(email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const code = latestCode(email, dir);
    if (code && code !== notBefore) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no verification code arrived for ${email} in ${dir}`);
}

/**
 * Verify in the browser: open the link, which is what sends the code, then type it. Leaves the page on
 * whatever the link opens, with the session cookie in the browser's jar.
 */
export async function verifyLink(page: Page, token: string, email: string, dir = MAIL_DIR): Promise<string> {
  const before = latestCode(email, dir);
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible({ timeout: 30_000 });
  const code = await waitForCode(email, dir, before);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  // The gate is a server component, so a verified link is a navigation away from the code screen.
  await expect(page.getByLabel("6-digit code")).toBeHidden({ timeout: 30_000 });
  return code;
}

/**
 * The same thing for a bare request context, for the specs that read the API directly. The cookie lands in
 * that context's jar, so its later GETs speak as the verified patient.
 */
export async function verifyByApi(request: APIRequestContext, token: string, email: string, dir = MAIL_DIR): Promise<string> {
  const before = latestCode(email, dir);
  const asked = await postJson(request, "/api/verify", { token });
  expect(asked.status(), `POST /api/verify: ${await asked.text()}`).toBe(202);
  const code = await waitForCode(email, dir, before);
  const verified = await postJson(request, "/api/verify", { token, code });
  expect(verified.status(), `POST /api/verify with the code: ${await verified.text()}`).toBe(200);
  return code;
}
