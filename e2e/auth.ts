import { expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// Signing in the way a provider does (design §5.1): type the address, read the link out of the mail that was
// "sent", open it. Nothing is stubbed — the only concession to a test is that with no email provider
// configured lib/mailer.ts drops the message in a directory instead of an inbox, and DEV_MAIL_DIR (set in
// playwright.config.ts) points that directory at e2e/.mail so the suite can read it.

export const MAIL_DIR = process.env.DEV_MAIL_DIR ?? "e2e/.mail";

/** The degraded server's own mailbox (playwright.config.ts). Each server writes only to its own, so a spec
 *  that signs in against port+1 has to be told to read this one. */
export const DEGRADED_MAIL_DIR = `${MAIL_DIR}-degraded`;

/** Which mailbox a sign-in reads. Defaults to the main server's. */
export type SignInOptions = { mailDir?: string };

/** The seeded provider, from scripts/seed.ts and lib/practice.ts. */
export const DEMO_EMAIL = "demo@sweetspot.local";

export type SignedInProvider = { id: string; name: string; email: string; role: string; practice: string | null; practiceId: string };

/** An address nothing else in the run will use. Two Playwright projects share one database and one mailbox,
 *  so a fixed address would have the two of them signing in as each other. */
export function freshEmail(prefix: string, domain = "example-endo.com"): string {
  return `${prefix}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@${domain}`;
}

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

/**
 * Take one of this address's sign-in links out of the mailbox, so nobody else can use it, and return it.
 *
 * A magic link is good once (§5.1): Auth.js deletes the token when it is redeemed. The suite signs in as the
 * seeded demo provider from several specs and two projects at a time, all against one mailbox, so "read the
 * newest link for this address" hands the same one-use token to two tests — and the second lands on
 * `/provider/signin?error=Verification`, "That link has already been used or has expired". Claiming is what
 * stops that: the rename is atomic, so of two tests reaching for one file exactly one gets it and the other
 * moves on to the next. Whose link a test ends up with does not matter, since every link for an address signs
 * in as that address; using one twice is the only thing that fails.
 */
function claimSignInLink(email: string, dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort().reverse();
  } catch {
    return null;
  }
  // An address is not a pattern: `nurse+demo@...` would otherwise match half the mailbox.
  const to = `To: ${email}`;
  for (const name of names) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // claimed and renamed between the listing and the read
    }
    if (!raw.split("\n").includes(to)) continue;
    const link = raw.match(/https?:\/\/\S*\/api\/auth\/callback\/email\S*/)?.[0];
    if (!link) continue;
    try {
      // The claim. `.claimed` does not end in .txt, so no later listing offers it again.
      renameSync(path, `${path}.claimed`);
    } catch {
      continue; // someone else claimed it first
    }
    return link;
  }
  return null;
}

/** Wait for a link to claim rather than sleeping: the send happens inside the POST, but the file write
 *  races it, and another test may be holding the only one that has arrived so far. */
async function waitForSignInLink(email: string, dir: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const link = claimSignInLink(email, dir);
    if (link) return link;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no sign-in link arrived for ${email} in ${dir}`);
}

/**
 * Sign in as one address and return who that turned out to be — id, role and practice — read back from the
 * session-scoped GET /api/provider. The page's cookies are the session afterwards, so page.request speaks as
 * them too. Nothing here knows whether the address existed: a seeded provider, an address an admin invited
 * (lib/teamStore.ts), and a stranger who gets a practice of their own all sign in by the same three steps.
 *
 * To change identity inside one test, clear the context's cookies first — otherwise /provider/signin sees a
 * session and redirects to the dashboard before the form is ever filled in.
 */
export async function signInAs(page: Page, email: string, opts: SignInOptions = {}): Promise<SignedInProvider> {
  const dir = opts.mailDir ?? MAIL_DIR;

  await page.goto("/provider/signin");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: /Email me a link/i }).click();
  await expect(page.locator("body")).toContainText(/emailed you a link/i, { timeout: 30_000 });

  // Claimed, so this token is this test's alone and no other test can spend it first.
  const link = await waitForSignInLink(email, dir);

  // The link is absolute and built from the request, so it already points at the right port.
  await page.goto(link);
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/, { timeout: 30_000 });
  // Auth.js sends a refused link back to /provider/signin?error=Verification, which the pattern above matches
  // too — so without this a spent link read as a successful sign-in and failed later as a puzzling 401.
  await expect(page, "the link should sign in, not bounce back to the form").not.toHaveURL(/\/provider\/signin/);

  const response = await page.request.get("/api/provider");
  expect(response.ok(), `GET /api/provider after sign-in: ${response.status()}`).toBeTruthy();
  const provider = await response.json();
  expect(provider.id).toBeTruthy();
  return provider as SignedInProvider;
}

/** The seeded demo provider, admin of the seeded practice (scripts/seed.ts). */
export const signInAsDemo = (page: Page, opts: SignInOptions = {}): Promise<SignedInProvider> => signInAs(page, DEMO_EMAIL, opts);

/** Sign the current identity out of the browser, so the next signInAs starts from nobody. */
export async function signOutOfBrowser(page: Page): Promise<void> {
  await page.context().clearCookies();
}
