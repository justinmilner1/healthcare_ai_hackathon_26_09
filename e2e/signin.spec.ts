import { expect, test } from "@playwright/test";
import { DEMO_EMAIL, latestSignInLink, signInAsDemo } from "./auth";
import { shot, WHOLE_PAGE } from "./shot";

// Provider sign-in end to end (design §5.1): the guard on /provider, the form, the "check your email" screen,
// the emailed link, and signing out again. The link is read from the local mailbox lib/mailer.ts writes to when
// no email provider is configured — the same path a developer uses with `npm run mail`, and the only part of
// the flow that is not exactly what production does.

test("the dashboard is behind sign-in", async ({ page }) => {
  await page.goto("/provider");
  await expect(page).toHaveURL(/\/provider\/signin/);
  await expect(page.getByRole("heading", { name: /Sign in with a link/i })).toBeVisible();
  await shot(page, "provider-signin", WHOLE_PAGE);
});

test("/demo fills in the seeded provider instead of signing them in", async ({ page }) => {
  await page.goto("/demo");
  await expect(page).toHaveURL(/\/provider\/signin/);
  await expect(page.getByLabel("Work email")).toHaveValue(DEMO_EMAIL);
});

test("asking for a link lands on check-your-email", async ({ page }) => {
  await page.goto("/provider/signin");
  await page.getByLabel("Work email").fill(DEMO_EMAIL);
  await page.getByRole("button", { name: /Email me a link/i }).click();
  await expect(page).toHaveURL(/\/provider\/check-email/);
  await expect(page.getByRole("heading", { name: /emailed you a link/i })).toBeVisible();
  await shot(page, "provider-check-email", WHOLE_PAGE);
});

test("an address the browser lets through still has to be an address", async ({ page }) => {
  // `nobody@localhost` passes the browser's own type=email check — it does not insist on a dot — so this is
  // what reaches the server action, and the server is what has to say no.
  await page.goto("/provider/signin");
  await page.getByLabel("Work email").fill("nobody@localhost");
  await page.getByRole("button", { name: /Email me a link/i }).click();

  await expect(page).toHaveURL(/\/provider\/signin\?error=InvalidEmail/);
  await expect(page.locator(".ss-error")).toContainText(/does not look like an email address/i);
  expect(latestSignInLink("nobody@localhost")).toBeNull();
});

test("signing up creates the practice and then asks for the same link", async ({ page }) => {
  // The form makes the Practice and its admin User; nobody is signed in by filling one in (§4.1, §4.2, §5.1).
  // A fresh address every run, because the same one twice would just rename an existing practice.
  const email = `nurse+${Date.now()}@northstar-endo.com`;
  await page.goto("/provider/signup");
  await page.getByLabel("Your name").fill("Dr Maya Chen");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: /Continue/i }).click();
  await page.getByLabel("Practice name").fill("Northstar Endocrinology");
  await page.getByRole("button", { name: /Create workspace/i }).click();
  await expect(page.locator("body")).toContainText(/emailed you a link/i, { timeout: 30_000 });

  const link = latestSignInLink(email);
  expect(link, "the sign-in link for a new practice").toBeTruthy();
  await page.goto(link!);
  await expect(page.locator("body")).toContainText(/Good to see you/i, { timeout: 30_000 });
  await expect(page.locator("body")).toContainText("Northstar Endocrinology");
});

test("the emailed link signs the provider in, and signing out ends it", async ({ page }) => {
  const demo = await signInAsDemo(page);
  expect(demo.id).toBeTruthy();
  await expect(page.locator("body")).toContainText(/Good to see you/i, { timeout: 30_000 });

  // The session is a cookie-bound database row, so the API answers for them without an id in the query.
  const mine = await page.request.get("/api/provider");
  expect(mine.ok()).toBeTruthy();
  expect((await mine.json()).id).toBe(demo.id);

  await page.getByRole("link", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/provider\/signout/);
  await expect(page.locator("body")).toContainText(DEMO_EMAIL);
  await shot(page, "provider-signout", WHOLE_PAGE);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);

  // Gone for real: the route refuses, and the dashboard sends them back to the form.
  expect((await page.request.get("/api/provider")).status()).toBe(401);
  await page.goto("/provider");
  await expect(page).toHaveURL(/\/provider\/signin/);
});
