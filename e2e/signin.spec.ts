import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, signInAsDemo } from "./auth";

// Provider sign-in end to end (design §5.1): the guard on /provider, the form, the "check your email" screen,
// the emailed link, and signing out again. The link is read from the local mailbox lib/mailer.ts writes to when
// no email provider is configured — the same path a developer uses with `npm run mail`, and the only part of
// the flow that is not exactly what production does.

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

test("the dashboard is behind sign-in", async ({ page }) => {
  await page.goto("/provider");
  await expect(page).toHaveURL(/\/provider\/signin/);
  await expect(page.getByRole("heading", { name: /Sign in with a link/i })).toBeVisible();
  await shot(page, "provider-signin");
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
  await shot(page, "provider-check-email");
});

test("an address that is not an address does not get a link", async ({ page }) => {
  // The browser's own validation is first, so post the form the way a script would.
  await page.goto("/provider/signin");
  await page.getByLabel("Work email").evaluate((input) => input.removeAttribute("type"));
  await page.getByLabel("Work email").fill("not-an-address");
  await page.getByRole("button", { name: /Email me a link/i }).click();
  await expect(page).toHaveURL(/\/provider\/signin\?error=InvalidEmail/);
  await expect(page.getByRole("alert")).toContainText(/does not look like an email address/i);
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
  await shot(page, "provider-signout");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);

  // Gone for real: the route refuses, and the dashboard sends them back to the form.
  expect((await page.request.get("/api/provider")).status()).toBe(401);
  await page.goto("/provider");
  await expect(page).toHaveURL(/\/provider\/signin/);
});
