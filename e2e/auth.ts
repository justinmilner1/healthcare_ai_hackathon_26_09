import { expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Signing in the way a provider does (design §5.1): type the address, read the link out of the mail that was
// "sent", open it. Nothing is stubbed — the only concession to a test is that with no email provider
// configured lib/mailer.ts drops the message in a directory instead of an inbox, and DEV_MAIL_DIR (set in
// playwright.config.ts) points that directory at e2e/.mail so the suite can read it.

export const MAIL_DIR = process.env.DEV_MAIL_DIR ?? "e2e/.mail";

/** The seeded provider, from scripts/seed.ts and lib/practice.ts. */
export const DEMO_EMAIL = "demo@sweetspot.local";

export type SignedInProvider = { id: string; name: string; practice: string | null };

/** The newest sign-in URL in the mailbox for this address, or null while nothing has arrived. */
export function latestSignInLink(email: string, dir = MAIL_DIR): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
  } catch {
    return null;
  }
  // An address is not a pattern: `nurse+demo@...` would otherwise match half the mailbox.
  const to = `To: ${email}`;
  for (const name of names.reverse()) {
    const raw = readFileSync(join(dir, name), "utf8");
    if (!raw.split("\n").includes(to)) continue;
    const link = raw.match(/https?:\/\/\S*\/api\/auth\/callback\/email\S*/)?.[0];
    if (link) return link;
  }
  return null;
}

/** Wait for the link rather than sleeping: the send happens inside the POST, but the file write races it. */
async function waitForSignInLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const link = latestSignInLink(email);
    if (link) return link;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no sign-in link arrived for ${email} in ${MAIL_DIR}`);
}

/**
 * Sign in as the seeded demo provider and return their id and practice, read back from the session-scoped
 * GET /api/provider. The page's cookies are the session afterwards, so page.request speaks as them too.
 */
export async function signInAsDemo(page: Page): Promise<SignedInProvider> {
  const before = latestSignInLink(DEMO_EMAIL);

  await page.goto("/provider/signin");
  await page.getByLabel("Work email").fill(DEMO_EMAIL);
  await page.getByRole("button", { name: /Email me a link/i }).click();
  await expect(page.locator("body")).toContainText(/emailed you a link/i, { timeout: 30_000 });

  // A link from an earlier test in the same run is still in the mailbox; wait for a different one.
  let link = await waitForSignInLink(DEMO_EMAIL);
  for (let attempt = 0; attempt < 40 && link === before; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    link = await waitForSignInLink(DEMO_EMAIL);
  }

  // The link is absolute and built from the request, so it already points at the right port.
  await page.goto(link);
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/, { timeout: 30_000 });

  const response = await page.request.get("/api/provider");
  expect(response.ok(), `GET /api/provider after sign-in: ${response.status()}`).toBeTruthy();
  const provider = await response.json();
  expect(provider.id).toBeTruthy();
  return provider as SignedInProvider;
}
