import { expect, test, type Page } from "@playwright/test";

// Both customer flows in scripted mode, with a screenshot of every screen. Screens are named so the builder and
// reviewer routines can find them: e2e/screenshots/<project>-<name>.png

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

test("landing renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText(/Sweet Spot|Sweetie/i);
  await shot(page, "landing");
});

test("practice flow: dashboard, add visit, invite link, Sour view", async ({ page, request }) => {
  // The demo provider exists after `npm run seed`.
  await page.goto("/demo");
  await expect(page).toHaveURL(/\/provider/);
  await shot(page, "provider-dashboard");

  const providers = await (await request.get("/api/provider?list=1")).json();
  const demo = providers.find((p: { name: string }) => /demo/i.test(p.name)) ?? providers[0];
  expect(demo).toBeTruthy();

  const booked = await (
    await request.post("/api/book", {
      data: { name: "E2E Patient", providerId: demo.id, visitType: "follow_up", reason: "mornings running high", optIn: false },
    })
  ).json();
  expect(booked.token).toBeTruthy();

  await page.goto(`/provider/${demo.id}`);
  await expect(page.locator("body")).toContainText(/Sour/i);
  await shot(page, "provider-sour");
});

test("patient flow: Sweetie two questions in scripted mode, then summary", async ({ page, request }) => {
  const providers = await (await request.get("/api/provider?list=1")).json();
  const demo = providers.find((p: { name: string }) => /demo/i.test(p.name)) ?? providers[0];
  const booked = await (
    await request.post("/api/book", {
      data: { name: "E2E Talker", providerId: demo.id, visitType: "follow_up", reason: "tired all the time", optIn: false },
    })
  ).json();

  await page.goto(`/s/${booked.token}`);
  await expect(page.locator("body")).toContainText(/Sweetie/i);
  await shot(page, "sweetie-start");

  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  for (const answer of [
    "Exhausted for six weeks, worse in the afternoons. I want to know if it's my sugars.",
    "New desk job in August and a cold two weeks ago. Shaky some mornings, sleeping about six hours.",
  ]) {
    await input.fill(answer);
    await input.press("Enter");
    await expect(page.locator("body")).toContainText(answer.slice(0, 20));
    await page.waitForTimeout(800);
  }
  await shot(page, "sweetie-done");

  const bundle = await (await request.get(`/api/patient/${booked.token}`)).json();
  expect(bundle.status.answered).toBeGreaterThanOrEqual(1);

  await page.goto(`/patient/${booked.token}`);
  await expect(page.locator("body")).toContainText(/week|summary|Sweet Spot/i);
  await shot(page, "patient-summary");
});
