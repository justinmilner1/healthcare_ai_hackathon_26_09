import { expect, test, type Page } from "@playwright/test";
import { signInAsDemo } from "./auth";

// Both customer flows in scripted mode, with a screenshot of every screen. Screens are named so the builder and
// reviewer routines can find them: e2e/screenshots/<project>-<name>.png

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

// Waits for a client fetch to paint, not for app logic: the page renders its shell first and fills in after. A
// slow runner can take longer than the 5s default to come back, so these get their own budget.
const LOADED = { timeout: 30_000 };

test("landing renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText(/Sweet Spot|Sweetie/i);
  await shot(page, "landing");
});

test("practice flow: sign in, dashboard, add visit, invite link, Sour view", async ({ page, request }) => {
  // The demo provider exists after `npm run seed`; signInAsDemo takes the emailed link (design §5.1).
  const demo = await signInAsDemo(page);
  await expect(page).toHaveURL(/\/provider/);
  // The dashboard fills in from a client fetch of GET /api/provider. Wait for the seeded patient, or the
  // screenshot catches an empty workspace and shows nothing about the data behind it.
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);
  await shot(page, "provider-dashboard");

  const booked = await (
    await request.post("/api/book", {
      data: { name: "E2E Patient", providerId: demo.id, visitType: "follow_up", reason: "mornings running high", optIn: false },
    })
  ).json();
  expect(booked.token).toBeTruthy();
  expect(booked.visitId).toBeTruthy();

  // Two ways to one visit (design §4.4, §5.3): the invite token and the visit id. A patient id is neither,
  // so the hackathon's patient-keyed lookup is gone.
  const byToken = await (await request.get(`/api/patient/${booked.token}`)).json();
  expect(byToken.visitId).toBe(booked.visitId);
  const byVisitId = await (await request.get(`/api/patient/${booked.visitId}`)).json();
  expect(byVisitId.patient.name).toBe("E2E Patient");
  expect((await request.get(`/api/patient/${booked.patientId}`)).status()).toBe(404);

  // The dashboard's rows are visits, and Sour and the invite are addressed by visit, not by patient.
  // page.request, not request: /api/provider answers for the session (§5.1) and the page holds the cookie.
  const providerRows = await (await page.request.get("/api/provider")).json();
  expect(providerRows.visits.map((v: { id: string }) => v.id)).toContain(booked.visitId);
  expect((await request.post("/api/sour", { data: { patientId: booked.patientId } })).status()).toBe(400);
  expect((await request.post("/api/invite", { data: { patientId: booked.patientId } })).status()).toBe(400);

  // ?visit=<id> is the deep link in the summary email (design §4.4). Open the seeded visit that way, and wait
  // for the one-pager itself: the page auto-generates on first open, and until it has, this is an empty shell.
  const seeded = providerRows.visits.find((v: { name: string }) => v.name === "Sam Sample");
  expect(seeded).toBeTruthy();
  await page.goto(`/provider/${demo.id}?visit=${seeded.id}`);
  await expect(page.locator(".sour-brief-header")).toContainText("Sam Sample", LOADED);
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible(LOADED);
  await shot(page, "provider-sour");
});

// T04 (design §3.4, §7.1): the summary is written by a `sour.run` job, not by the request that asks for it.
// With no scheduler the app drains its own queue after the response, so opening a patient who has uploads and
// no summary must still end with a summary on the page — through the queue, with the two "it's ready" links
// queued behind it. Nothing here stubs the runner; if the job never ran, no summary appears.
test("summary generation goes through the job queue", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const detail = await (await page.request.get("/api/provider")).json();
  // The seeded visit is the one with uploaded files (`npm run seed`); rows are visits now (design §4.4).
  const seeded = detail.visits.find((v: { name: string; uploads: string[] }) => v.uploads.length > 0);
  expect(seeded, "npm run seed creates a patient with sample uploads").toBeTruthy();

  await page.goto(`/provider/${demo.id}?visit=${seeded.id}`);
  await expect(page.locator(".sour-brief")).toContainText(seeded.name, LOADED);
  // The charts and the numbers come straight from the uploads, so they are on screen before any job has run;
  // the Patterns block is the part only a saved summary fills. In scripted mode Sour writes both summaries
  // with this placeholder where the model's patterns would be, so its arrival is the queue having worked.
  await expect(page.locator(".sour-brief")).toContainText(/set OPENAI_API_KEY/i, LOADED);
  await expect(page.locator(".sour-brief")).not.toContainText(/Sour is reading the data/i);
  await shot(page, "provider-sour-generated");

  // The runner route is the other way in, and it is public: without the shared secret it refuses rather than
  // draining for anyone who asks. The e2e servers set no JOBS_SECRET, so this is the unconfigured answer.
  const refused = await request.post("/api/jobs/run");
  expect(refused.status()).toBe(503);
  expect((await refused.json()).error).toMatch(/not configured/i);
});

test("patient flow: Sweetie two questions in scripted mode, then summary", async ({ page, request }) => {
  // No sign-in and no providerId: the patient's credential is the token in the link (§5.3), and /api/book
  // falls back to the seeded demo provider.
  const booked = await (
    await request.post("/api/book", {
      data: { name: "E2E Talker", visitType: "follow_up", reason: "tired all the time", optIn: false },
    })
  ).json();

  await page.goto(`/s/${booked.token}`);
  await expect(page.locator("body")).toContainText(/Sweetie/i);
  // "Sweetie" is in the chrome, so it matches before the intake has loaded. GET /api/sweetie is what writes the
  // opening question and returns the field list, and until it answers the transcript is empty and the progress
  // card reads "0 of — questions answered". Wait for the greeting itself, so the screenshot is of the first
  // question rather than of the shell around it. The greeting is used rather than the question count because the
  // count is hidden by CSS on the mobile layout; LOADED above explains the timeout.
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
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
  // The loading card says "getting your week ready", which the old loose text check matched, so the screenshot was
  // of a spinner. Assert on something only the loaded summary has.
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  await shot(page, "patient-summary");
});
