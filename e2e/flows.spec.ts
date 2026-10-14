import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";

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
  // page.request, not request, for everything below that speaks as a provider: §5.2 (T06) puts every provider
  // route behind the session and the role, and the page's cookies are that session. The patient's own way in —
  // the invite token — is the one thing still asked for without one, and is asked for through `request` on
  // purpose, to show it needs no session at all.
  // The demo provider exists after `npm run seed`; signInAsDemo takes the emailed link (design §5.1).
  const demo = await signInAsDemo(page);
  await expect(page).toHaveURL(/\/provider/);
  // The dashboard fills in from a client fetch of GET /api/provider. Wait for the seeded patient, or the
  // screenshot catches an empty workspace and shows nothing about the data behind it.
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);
  await shot(page, "provider-dashboard");

  // postJson adds the CSRF header the way the dashboard does (design §10.8, e2e/api.ts).
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Patient", providerId: demo.id, visitType: "follow_up", reason: "mornings running high", optIn: false })
  ).json();
  expect(booked.token).toBeTruthy();
  expect(booked.visitId).toBeTruthy();

  // Two ways to one visit (design §4.4, §5.3): the invite token and the visit id. A patient id is neither,
  // so the hackathon's patient-keyed lookup is gone.
  const byToken = await (await request.get(`/api/patient/${booked.token}`)).json();
  expect(byToken.visitId).toBe(booked.visitId);
  const byVisitId = await (await page.request.get(`/api/patient/${booked.visitId}`)).json();
  expect(byVisitId.patient.name).toBe("E2E Patient");
  expect((await page.request.get(`/api/patient/${booked.patientId}`)).status()).toBe(404);

  // The dashboard's rows are visits, and Sour and the invite are addressed by visit, not by patient.
  // page.request, not request: /api/provider answers for the session (§5.1) and the page holds the cookie.
  const providerRows = await (await page.request.get("/api/provider")).json();
  expect(providerRows.visits.map((v: { id: string }) => v.id)).toContain(booked.visitId);
  // Through postJson, and as the signed-in page: without the CSRF header these are a 403 from middleware and
  // without the session a 401 from the guard, and neither asserts anything about §4.4.
  expect((await postJson(page.request, "/api/sour", { patientId: booked.patientId })).status()).toBe(400);
  expect((await postJson(page.request, "/api/invite", { patientId: booked.patientId })).status()).toBe(400);

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
// T15 adds the tail of this test: the job's state on the page, and that asking again over unchanged inputs
// returns the summary already saved rather than writing a second one.
// With no scheduler the app drains its own queue after the response, so opening a patient who has uploads and
// no summary must still end with a summary on the page — through the queue, with the two "it's ready" links
// queued behind it. Nothing here stubs the runner; if the job never ran, no summary appears.
test("summary generation goes through the job queue", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const detail = await (await page.request.get("/api/provider")).json();
  // The seeded visit is the one with uploaded files (`npm run seed`); rows are visits now (design §4.4).
  // Named, not just "the first row with uploads": other specs upload files too (e2e/uploads.spec.ts), and
  // this one wants the four-source demo patient, both for the assertions and for the screenshot.
  const seeded = detail.visits.find((v: { name: string; uploads: string[] }) => v.name === "Sam Sample" && v.uploads.length > 0);
  expect(seeded, "npm run seed creates a patient with sample uploads").toBeTruthy();

  await page.goto(`/provider/${demo.id}?visit=${seeded.id}`);
  await expect(page.locator(".sour-brief")).toContainText(seeded.name, LOADED);
  // The charts and the numbers come straight from the uploads, so they are on screen before any job has run;
  // the Patterns block is the part only a saved summary fills. In scripted mode Sour writes both summaries
  // with this placeholder where the model's patterns would be, so its arrival is the queue having worked.
  await expect(page.locator(".sour-brief")).toContainText(/set OPENAI_API_KEY/i, LOADED);
  await expect(page.locator(".sour-brief")).not.toContainText(/Sour is reading the data/i);
  // T15 (§7.2): the job's own state, not an inference from the summary's timestamp. Once the queue has run,
  // the chip reads Ready; while it was queued or running it said so, and a failure would name the reason and
  // offer the retry (lib/sourState.ts has every transition).
  const chip = page.locator(".sour-job-state");
  await expect(chip).toHaveAttribute("data-phase", "ready", LOADED);
  await expect(chip).toContainText(/Ready/);
  await shot(page, "provider-sour-generated");

  // The runner route is the other way in, and it is public: without the shared secret it refuses rather than
  // draining for anyone who asks. The e2e servers set no JOBS_SECRET, so this is the unconfigured answer.
  const refused = await request.post("/api/jobs/run");
  expect(refused.status()).toBe(503);
  expect((await refused.json()).error).toMatch(/not configured/i);

  // T15 (§7.1): "a second run with unchanged inputs returns the existing summary". Asked here, of the visit
  // the queue has just summarized, rather than from a test of its own — every sign-in competes for the same
  // demo mailbox, and a magic link is single use, so the cheapest way to keep this assertion reliable is not
  // to ask for a second session to make it. The saving is only half the point: the other half is that the
  // page can tell the difference, since a reused summary leaves its own timestamp exactly where it was.
  const read = async () => (await page.request.get(`/api/patient/${seeded.id}`)).json();
  const before = await read();
  expect(before.providerSummary, "the queue wrote one above").toBeTruthy();
  expect(before.summaryStale, "nothing has changed since that summary was written").toBe(false);

  // Through postJson: a bare POST is a 403 from the CSRF middleware (§10.8) and would assert nothing.
  const queued = await (await postJson(request, "/api/sour", { visitId: seeded.id })).json();
  expect(queued.jobId).toBeTruthy();

  let after = before;
  for (let tries = 0; tries < 40; tries++) {
    await new Promise((r) => setTimeout(r, 500));
    after = await read();
    if (after.sourJob?.id === queued.jobId && after.sourJob.status === "done") break;
  }
  expect(after.sourJob?.status, "the run reported back").toBe("done");
  expect(after.providerSummaryAt, "the saved pair came back rather than a third one being written").toBe(before.providerSummaryAt);
  expect(after.patientSummaryAt).toBe(before.patientSummaryAt);
  expect(after.summaryStale).toBe(false);
});

test("patient flow: Sweetie two questions in scripted mode, then summary", async ({ page, request }) => {
  // Someone at the practice books the visit — staff's job, and it needs their session now (§5.2) — and from
  // there the patient has no account and no sign-in: the token in the link is their credential (§5.3), which
  // is why every request below goes through `request` rather than the signed-in page.
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Talker", visitType: "follow_up", reason: "tired all the time", optIn: false })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);

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

// T15 (design §7.1, §7.2): the other side of reuse. A summary is only reusable while the inputs are the ones
// it was made from, so a file arriving afterwards has to be visible as such — the chip says the summary is
// out of date, and Regenerate really writes a new one rather than handing back the saved pair.
test("a file arriving after a summary makes it out of date, and regenerating writes a new one", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const booked = await (
    await postJson(request, "/api/book", { name: "E2E Fresh Data", visitType: "follow_up", reason: "spikes after dinner", optIn: false })
  ).json();
  expect(booked.token).toBeTruthy();

  // Multipart, so postJson does not fit; the CSRF header is the same one it would have added (§10.8).
  const upload = async (kind: string, path: string, name: string) => {
    const res = await request.post("/api/upload", {
      headers: { "x-csrf-token": await csrfToken(request) },
      multipart: { token: booked.token, kind, file: { name, mimeType: "text/csv", buffer: readFileSync(path) } },
    });
    expect(res.ok(), `${kind} upload`).toBeTruthy();
  };
  await upload("dexcom", "data/dexcom_clarity_sample.csv", "clarity.csv");

  // Opening a patient with data and no summary generates one without asking.
  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  const chip = page.locator(".sour-job-state");
  await expect(chip).toHaveAttribute("data-phase", "ready", LOADED);
  await shot(page, "provider-sour-ready");
  const first = await (await page.request.get(`/api/patient/${booked.visitId}`)).json();
  expect(first.summaryStale).toBe(false);

  // A WHOOP export lands afterwards: the saved summary no longer describes the visit.
  await upload("whoop", "data/whoop_sample.csv", "cycles.csv");
  await page.reload();
  await expect(chip).toHaveAttribute("data-phase", "stale", LOADED);
  await expect(chip).toContainText(/Out of date/);
  await shot(page, "provider-sour-stale");

  // And Regenerate is a real run, not the saved pair coming back.
  await page.getByRole("button", { name: /Regenerate/ }).click();
  await expect(chip).toHaveAttribute("data-phase", "ready", LOADED);
  const second = await (await page.request.get(`/api/patient/${booked.visitId}`)).json();
  expect(second.summaryStale).toBe(false);
  expect(second.providerSummaryAt).not.toBe(first.providerSummaryAt);
});
