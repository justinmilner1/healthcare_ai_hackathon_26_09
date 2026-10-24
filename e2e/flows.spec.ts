import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { expectNoHorizontalScroll, expectTranscriptUncut } from "./mobile";
import { EYEBROW, expectNoCoordinates, patientEmail, verifyByApi, verifyLink } from "./patient";
import { SCREENFUL, shot, WHOLE_PAGE } from "./shot";
import { UNNAMED_PLACE } from "../lib/spikePlaces";

// Both customer flows in scripted mode, with a screenshot of every screen. Screens are named so the builder and
// reviewer routines can find them: e2e/screenshots/<project>-<name>.png. e2e/shot.ts decides how much of the
// page each one gets: the patient screens are the page, the dashboard is one screenful with its table in it.. e2e/shot.ts decides how much of the
// page each one gets: the patient screens are the page, the dashboard is one screenful with its table in it.

/**
 * The hero illustration names the two agents, and nothing in it may cover those names (T52, design §2, §6.5).
 *
 * Measured rather than eyeballed because the three boxes are absolutely positioned against a column whose
 * width is a percentage: the captions and the handoff pill move apart or together with the viewport, and the
 * overlap that hid "Sweetie" at 1280px and both names at 375px was invisible in the markup. The test runs in
 * both projects, so the two widths §6.5 and the ticket name are both covered.
 */
async function expectHeroCaptionsLegible(page: Page): Promise<void> {
  const covered = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    type Box = NonNullable<ReturnType<typeof box>>;
    const over = (a: Box, b: Box) => {
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      // A pixel of slack: the boxes are laid out from percentages, so edges that are meant to meet can
      // measure as a hair of overlap without a reader losing a single letter.
      return x > 1 && y > 1 ? `${a.selector} covers ${b.selector} by ${Math.round(x)}×${Math.round(y)}px` : null;
    };
    const sweetie = box(".home-character-sweetie figcaption");
    const sour = box(".home-character-sour figcaption");
    const pill = box(".home-handoff");
    const visual = box(".home-visual");
    const found: string[] = [];
    if (!sweetie || !sour || !pill || !visual) return ["the hero is missing a caption or the handoff pill"];
    for (const caption of [sweetie, sour]) {
      const hit = over(pill, caption);
      if (hit) found.push(hit);
      // Clipped by the visual's own `overflow: hidden` is the other way a caption disappears.
      if (caption.left < visual.left - 1 || caption.right > visual.right + 1
        || caption.top < visual.top - 1 || caption.bottom > visual.bottom + 1) {
        found.push(`${caption.selector} is clipped by .home-visual`);
      }
    }
    const both = over(sweetie, sour);
    if (both) found.push(both);
    return found;
  });
  expect(covered, "the hero captions name Sweetie and Sour; nothing may cover them (design §2, §6.5)").toEqual([]);
}

test("landing renders", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText(/Sweet Spot|Sweetie/i);
  // Both names are on the page, and both are readable: the figcaptions are what the two alt texts introduce.
  await expect(page.locator(".home-character-sweetie figcaption")).toContainText("Sweetie");
  await expect(page.locator(".home-character-sour figcaption")).toContainText("Sour");
  await expectHeroCaptionsLegible(page);
  // The captions are moved by hand-placed offsets, so the way to push one out of the pill's way is also the
  // way to push it past the right edge. §6.5's own measurement, on the one screen e2e/mobile.spec.ts does
  // not cover: that file is the patient screens, and this is the front door in front of them. Mobile only —
  // at 1280px the document fits anything and the assertion would pass while meaning nothing.
  if (testInfo.project.name === "mobile") await expectNoHorizontalScroll(page, "the landing page");
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
  // The row this test is about, centred in the shot: the dashboard is as tall as the practice's visit
  // list, and one screenful of somebody else's rows answers nothing (T57, T81).
  await shot(page, "provider-dashboard", {
    ...SCREENFUL,
    scrollTo: '.provider-table tbody tr:has-text("Sam Sample")',
    block: "center",
  });

  // postJson adds the CSRF header the way the dashboard does (design §10.8, e2e/api.ts). The email is where
  // the patient's six-digit code goes (T08, §5.3), so a booking without one could never be opened.
  const email = patientEmail("E2E Patient");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Patient", email, providerId: demo.id, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token).toBeTruthy();
  expect(booked.visitId).toBeTruthy();

  // T08 (§5.3): the token names the visit, and a verified session is what opens it. Unverified, the link is a
  // closed door — which is the whole claim of §2.3, so it is asserted before it is opened.
  expect((await request.get(`/api/patient/${booked.token}`)).status()).toBe(401);
  await verifyByApi(request, booked.token, email);

  // Two ways to one visit (design §4.4, §5.3): the invite token and the visit id. A patient id is neither,
  // so the hackathon's patient-keyed lookup is gone. Each has its own credential: the patient's verified
  // session above, and the clinician's own sign-in, which is why that one goes through page.request.
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

  // /api/provider has the row; §12.2 asks whether the practice can see it. The workspace signed in above was
  // loaded before the booking and fills in from one client fetch, so it has to be opened again — `/provider`,
  // which is the table; `/provider/<id>` below is Sour's one-pager and shows no patient list at all. The row
  // is found by the address this booking was given rather than by the name: the desktop and mobile projects
  // run this spec against one database, so by the second project two visits are called "E2E Patient" and only
  // the address is this one's. Waiting for `Sam Sample` instead — the seeded patient, which is what this used
  // to assert — passes on a dashboard that drops the visit just created.
  await page.goto("/provider");
  const bookedRow = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(bookedRow).toContainText("E2E Patient", LOADED);
  // The visit's own details, not just a name that happens to be in the table: the type and the reason the
  // booking was made with (design §2.2), which is what tells this row apart from the same patient's others.
  await expect(bookedRow).toContainText("Follow-up");
  await expect(bookedRow).toContainText("mornings running high");
  // T54: and the seeded row beside it, which is what a demo and the staging practice are shown first. It used
  // to read the `visitLabel` fallback "Visit", because `npm run seed` set neither of those two §2.2 fields.
  const seededRow = page.locator(".provider-table tbody tr", { hasText: "Sam Sample" }).first();
  await expect(seededRow).toContainText("Follow-up");
  await expect(seededRow).toContainText("going high overnight");
  await shot(page, "provider-dashboard-booked", { ...SCREENFUL, scrollTo: bookedRow, block: "center" });

  // ?visit=<id> is the deep link in the summary email (design §4.4). Open the seeded visit that way, and wait
  // for the one-pager itself: the page auto-generates on first open, and until it has, this is an empty shell.
  const seeded = providerRows.visits.find((v: { name: string }) => v.name === "Sam Sample");
  expect(seeded).toBeTruthy();
  await page.goto(`/provider/${demo.id}?visit=${seeded.id}`);
  await expect(page.locator(".sour-brief-header")).toContainText("Sam Sample", LOADED);
  // T54: the seeded visit's type and reason reach the brief too, not the "Visit" fallback.
  await expect(page.locator(".sour-brief-header")).toContainText("Follow-up");
  await expect(page.locator(".sour-called-about")).toContainText("going high overnight");
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
  // the note under the chip is the part only a saved summary puts there. This suite runs with no model key,
  // so Sour saves the numbers with both narrative sections empty and the reason as page state (T63, §6.3,
  // §11.3) — so the note's arrival is the queue having worked.
  const note = page.locator(".sour-degraded-note");
  await expect(note).toContainText(/Assistant not configured/i, LOADED);
  // §2.7, §10.6: what the clinician is told is who to ask, never the name of a variable, and the patient
  // reads a version of this screen. T96: nor a practice role — `Practice` has no assistant to enable, so a
  // note pointing at Settings or at the practice admin points at nothing (lib/sourState.ts).
  await expect(note).toContainText(/ask whoever set Sweet Spot up for your office/i);
  await expect(note).not.toContainText(/administrator|turn it on/i);
  await expect(page.locator(".sour-brief")).not.toContainText(/OPENAI|API_KEY/i);
  await expect(page.locator(".sour-brief")).not.toContainText(/Sour is reading the data/i);
  // T15 (§7.2): the job's own state, not an inference from the summary's timestamp. Once the queue has run,
  // the chip reads Ready; while it was queued or running it said so, and a failure would name the reason and
  // offer the retry (lib/sourState.ts has every transition).
  const chip = page.locator(".sour-job-state");
  await expect(chip).toHaveAttribute("data-phase", "ready", LOADED);
  await expect(chip).toContainText(/Ready/);
  // T99 (§2.6): the seeded visit has a Timeline beside its Dexcom, so this is the brief's other shape — the
  // caption may name a place, and still says what the unplaced markers carry. Read from the bundle rather
  // than assumed, so a sample that drifts says so here instead of failing on a missing word.
  const placed = ((await (await page.request.get(`/api/patient/${seeded.id}`)).json()) as { spikes: { visit?: unknown }[] }).spikes;
  expect(placed.some((s) => s.visit), "the seeded week has a rise the matcher placed").toBeTruthy();
  const caption = page.locator(".sour-chart-caption");
  await expect(caption).toContainText("the place the patient had just left");
  await expect(caption).toContainText("peak mg/dL");
  await expect(caption, "colliding labels are dropped, so not every marker carries one").toContainText("Labels, where they fit,");
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

  // page.request, not request: /api/sour needs the provider session (§5.2, T06) as well as the CSRF header
  // (§10.8), and the page is what holds the cookie. A bare POST is a 403, a session-less one a 401, and
  // either would assert nothing about §7.1.
  const queued = await (await postJson(page.request, "/api/sour", { visitId: seeded.id })).json();
  expect(queued.jobId).toBeTruthy();

  // expect.poll rather than a loop around setTimeout: the same bounded wait on the same condition — this
  // job, reported done — but it is the assertion that fails, naming the last status it saw, instead of a loop
  // running out of tries silently and a separate expect afterwards left to guess at why.
  let after = before;
  await expect
    .poll(async () => {
      after = await read();
      return after.sourJob?.id === queued.jobId ? after.sourJob.status : null;
    }, { message: "the run reported back", ...LOADED })
    .toBe("done");
  expect(after.providerSummaryAt, "the saved pair came back rather than a third one being written").toBe(before.providerSummaryAt);
  expect(after.patientSummaryAt).toBe(before.patientSummaryAt);
  expect(after.summaryStale).toBe(false);
});

/**
 * The patient flow end to end, and the promise it ends on (T143, design §2.5, §2.6, §7.1).
 *
 * The check-in shares nothing — no Dexcom, no Timeline, no WHOOP — which is what makes the last half of this
 * test the ticket: Sweetie's closing sentence tells the patient their doctor will see a one-page summary
 * before the visit, and until T143 the wrap queued the `sour.run` only when the visit already had glucose.
 * So on this visit nothing produced that summary, no `notify.summary` carried §2.6's clinician link, and the
 * brief said "No summary yet." behind a Generate button nobody had been asked to press. Both halves are
 * asserted here, in one test, because the bug was only ever visible as the two of them disagreeing.
 */
test("patient flow: Sweetie two questions in scripted mode, then the summary she promised", async ({ page }) => {
  // Someone at the practice books the visit — staff's job, and it needs their session now (§5.2) — and from
  // there the patient has no provider account: the link plus the code sent to the address on file is their
  // whole credential (§5.3). The provider's session is dropped before the link is opened, so everything after
  // that point is the patient's own browser and nobody else's.
  await signInAsDemo(page);
  const email = patientEmail("E2E Talker");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Talker", email, visitType: "follow_up", reason: "tired all the time", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);

  // The link opens a code screen first (T08, §2.3); the code comes out of the console mailer (e2e/patient.ts).
  await verifyLink(page, booked.token, email);
  await expect(page.locator("body")).toContainText(/Sweetie/i);
  // "Sweetie" is in the chrome, so it matches before the intake has loaded. GET /api/sweetie is what writes the
  // opening question and returns the field list, and until it answers the transcript is empty and the progress
  // card reads "0 of — questions answered". Wait for the greeting itself, so the screenshot is of the first
  // question rather than of the shell around it. The greeting is used rather than the question count because the
  // count is hidden by CSS on the mobile layout; LOADED above explains the timeout.
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await shot(page, "sweetie-start", WHOLE_PAGE);

  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  // Sweetie's own bubbles, with the typing indicator left out: it is a `.sweetie-message` too, in a row of the
  // same shape, and it comes and goes on its own. POST /api/sweetie answers every message with exactly one
  // reply and the page appends it (`applyReply` in app/s/[token]/page.tsx), so one more bubble is the reply
  // having landed. That is the signal this loop waits on. It used to sleep 800ms instead, which is both too
  // long and too short: `send` ignores anything typed while a reply is in flight, so a slow run typed the
  // second answer into a busy page and lost it, and a fast one paid the rest of the 800ms for nothing.
  const sweetieSaid = page.locator(
    ".sweetie-messages .sweetie-message-row:not(.sweetie-message-patient) .sweetie-message:not(.sweetie-typing)",
  );
  for (const answer of [
    "Exhausted for six weeks, worse in the afternoons. I want to know if it's my sugars.",
    "New desk job in August and a cold two weeks ago. Shaky some mornings, sleeping about six hours.",
  ]) {
    const said = await sweetieSaid.count();
    await input.fill(answer);
    await input.press("Enter");
    await expect(page.locator("body")).toContainText(answer.slice(0, 20));
    await expect(sweetieSaid).toHaveCount(said + 1, LOADED);
  }
  // Both answers are in, so the intake has wrapped and the transcript ends with the completion card. The
  // transcript is its own scrolling region and glides to the newest message rather than jumping (§6.4), so
  // the reply landing is not the same moment as the end of the transcript being on screen — asserting the
  // card is really in the viewport waits for that glide to finish, and the shot is of the finished check-in
  // rather than of the greeting it started from. The old sleep covered this by accident.
  const doneCard = page.locator(".sweetie-done-card");
  await expect(doneCard).toContainText(/check-in is complete/i, LOADED);
  await expect(doneCard).toBeInViewport();
  // The card that ends the check-in is the last thing in the transcript, so it is the message T83's second
  // criterion is about: on the phone this shot was of a completion card with its first line sliced off.
  await expectTranscriptUncut(page, "the end of the check-in");
  // The ending T142 left alone, asserted so it stays left alone: answered to the end is the one state that
  // still has a number, and it is a full one beside the sentence that says so (lib/intakeProgress.ts).
  await expect(page.locator(".sweetie-progress-card strong")).toHaveText("100%");
  await expect(page.locator(".sweetie-progress-card small")).toHaveText("Your story is ready");
  // T143: the claim the end of this test is about, in Sweetie's own words. With no model key the scripted
  // wrap line is what every patient reads (§6.3, lib/sweetie.ts `scripted`), and this visit has shared
  // nothing — which is exactly the state in which nobody used to produce the summary it promises.
  await expect(page.locator(".sweetie-messages")).toContainText("Your doctor will see a one-page summary before your visit");
  await shot(page, "sweetie-done", WHOLE_PAGE);

  // page.request, not request: the verified session lives in the browser's cookie jar (§5.3).
  const bundle = await (await page.request.get(`/api/patient/${booked.token}`)).json();
  expect(bundle.status.answered).toBeGreaterThanOrEqual(1);

  await page.goto(`/patient/${booked.token}`);
  // The loading card is a card with Sweetie on it, which the old loose text check matched, so the
  // screenshot was of a spinner. Assert on something only the loaded summary has. (The card's own copy is
  // held by the T132 test at the end of this file, which stalls the response instead of racing it.)
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  // T41 (§2.7, §6): the chip row names the visit in words. This visit was booked as `follow_up`, and the row
  // read exactly that until the page started going through visitLabel() — a column value on the one screen
  // written for the patient. Asserted here as well as in the sweep below because this is the row the
  // screenshot is of.
  await expect(page.locator(".patient-summary-meta")).toContainText("Follow-up");
  await expect(page.locator(".patient-summary-meta")).not.toContainText("follow_up");
  await shot(page, "patient-summary", WHOLE_PAGE);

  // T143: the other half of what Sweetie just promised. Nothing was shared, so this is the visit whose wrap
  // used to queue no run at all. The patient's session goes first — the clinician's half of a bundle is not
  // a patient's to receive (§5.2, §10.6, app/api/patient/[id]), so the state asserted below is only
  // readable as a provider, and signOutOfBrowser is what lets one test be two identities (e2e/auth.ts).
  await signOutOfBrowser(page);
  const clinician = await signInAsDemo(page);
  await page.goto(`/provider/${clinician.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Talker", LOADED);
  // The run the wrap queued, reported by the job's own state rather than inferred from the page (§7.2).
  // Nothing here presses Generate: if the wrap queued nothing, this chip never leaves "none" and the
  // assertion says so. The first-open auto-generate is behind the same predicate the wrap is, so it is not
  // a second way for this to pass either — both changed together (app/provider/[id]/sour.tsx).
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", LOADED);
  await expect(page.locator(".sour-brief")).not.toContainText(/No summary yet/i);
  // What the clinician gets is the brief the product already had for this state, and it says what it has.
  await expect(page.locator(".sour-no-glucose-note")).toContainText("This summary is from the conversation only.");
  // The handover §2.6 is about: the patient's own words, on the clinician's page, from a check-in with no
  // numbers in it at all.
  await expect(page.locator(".sour-brief")).toContainText("Exhausted for six weeks");
  // And no invented figure beside them. The suite runs with no model key, so the narrative sections are
  // empty by design (§6.3) and every number on this page would have come from `renderSourInput`'s zeros.
  await expect(page.locator(".sour-brief")).not.toContainText(/Time in range/i);
  await shot(page, "provider-sour-conversation-only", { ...SCREENFUL, scrollTo: ".sour-no-glucose-note", block: "center" });
});

/**
 * A check-in the safety scan stopped, and what happens to the message after it (T97, design §2.5, §6.2).
 *
 * §2.5 is one sentence: "a flag stops the interview and tells the patient to call the office or 911". The
 * flag used to stop the *turn* it fired on and nothing more — the composer underneath the instruction was
 * live, and anything typed into it ran a whole turn and came back with the next intake question. This test
 * is both halves of the fix in one place: the screen stops inviting a reply, and the transport refuses to
 * interview even when something posts anyway. It runs in both projects, so the flagged screen is shot at
 * 1280px as well as at the 375px e2e/mobile.spec.ts measures.
 */
test("a flagged check-in stops: no composer, and a later message is not interviewed", async ({ page }) => {
  await signInAsDemo(page);
  const email = patientEmail("E2E Flagged");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Flagged", email, visitType: "follow_up", reason: "tired all the time", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);

  await verifyLink(page, booked.token, email);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // One of lib/sweetie.ts's red flags, in a sentence a patient would actually write.
  const input = page.getByLabel("Reply to Sweetie");
  await input.fill("I had chest pain yesterday evening and it really scared me.");
  await input.press("Enter");

  // §2.5's instruction, as the card that ends the transcript (T66 built this part).
  const flaggedCard = page.locator(".sweetie-flagged-card");
  await expect(flaggedCard).toBeVisible(LOADED);
  await expect(flaggedCard.locator("strong")).toContainText(/call .+'s office today/i);

  // T141, §2.5 and §2.7: nothing was uploaded here, so `/patient/<token>` has no summary to render and the
  // card may not offer one. It used to, unconditionally — the one surface T137 did not reach — and the
  // press landed on "Your glucose story is ready for its first chapter" over a button back to this very
  // check-in, the one that has just stopped talking to them. Asserted across the whole transcript rather
  // than inside the card, because the round trip is the defect wherever the anchor is drawn.
  await expect(
    page.locator(`.sweetie-conversation a[href="/patient/${booked.token}"]`),
    "a stopped check-in with nothing shared offers no summary (T141)",
  ).toHaveCount(0);
  // Not silence either: what the patient did tell Sweetie reached their care team, and the card says so
  // where the link was. §2.5's instruction is still the first thing on it.
  await expect(flaggedCard.locator(".sweetie-flagged-kept")).toHaveText("What you shared is saved for your care team");
  const flaggedOrder = await flaggedCard.locator("div > *").allTextContents();
  expect(flaggedOrder[0], "§2.5's instruction is the headline, as T66 left it").toMatch(/call .+'s office today/i);

  // The composer is gone, and what stands in its place says why, in a live region rather than as a disabled
  // control that announces nothing (§6.4). The mic and Send go with the input: all three or none.
  await expect(page.getByLabel("Reply to Sweetie")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send message/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Talk to Sweetie|Stop voice/i })).toHaveCount(0);
  const stoppedNote = page.locator(".sweetie-composer-stopped");
  await expect(stoppedNote).toBeVisible();
  await expect(stoppedNote).toHaveAttribute("role", "status");
  await expect(stoppedNote).toContainText(/check-in has stopped/i);
  await expect(stoppedNote).toContainText(/call .+'s office today/i);
  await expect(page.locator(".sweetie-done-card")).toHaveCount(0);

  // The transcript glides to the newest message rather than jumping (§6.4), so the card being in the
  // document is not the same moment as all of it being on screen: the first desktop shot of this screen
  // caught the glide in flight and cut the instruction off at the bottom of the region. This waits the
  // glide out and fails if the card does not fit whole (T83), so the committed PNG is evidence about the
  // card and not about the scroll.
  await expectTranscriptUncut(page, "the stopped check-in");

  await shot(page, "sweetie-flagged-stopped", WHOLE_PAGE);

  // And the transport, which is what a patient's own voice path, a second tab or anything else that posts
  // would reach: the message is stored (§6.2 — what someone says after a flag is what the office wants to
  // read), the answer repeats the instruction, and no new question is asked.
  const said = await (
    await postJson(page.request, "/api/sweetie", { token: booked.token, message: "ok thanks, should I still answer the questions?" })
  ).json();
  expect(said.reply, "Sweetie answered the message after the flag").toBeTruthy();
  expect(said.reply).toMatch(/office today/i);
  expect(said.reply).not.toMatch(/\?/);
  expect(said.reply, "a stopped check-in is not a complete one").not.toMatch(/complete/i);
  expect(said.intake.flagged, "the flag the office is being told about is unchanged").toBe("cardiac_or_breathing");

  // The transcript holds what they said, and the stored intake has not reopened a question behind it.
  const stored = await (await page.request.get(`/api/sweetie?token=${booked.token}`)).json();
  expect(stored.messages.map((m: { content: string }) => m.content).join("\n")).toContain("should I still answer the questions?");
  expect(stored.intake.flagged).toBe("cardiac_or_breathing");
  expect(stored.intake.wrapped).toBe(true);
  // §2.5 stopped the check-in where it stood, and a later message does not reopen it — which is what these
  // two assertions are, in the two directions a status can move.
  //
  // Forwards is now T143 rather than this message. A flagged turn wraps (lib/sweetieTurn.ts), so the wrap
  // queues the `sour.run` every wrap queues, `runSour` saves a brief from the conversation and the visit
  // reaches `summary_ready` on its own — and on this visit that is the point of the ticket: the patient has
  // described something urgent, shared no readings at all, and before T143 nobody told their clinician.
  // Backwards is what must never happen, and both writers guard it with a `from` list rather than an
  // update (app/api/sweetie/route.ts, lib/sourRun.ts `markSummaryReady`).
  const visitStatus = async () => (await (await page.request.get(`/api/patient/${booked.token}`)).json()).visitStatus;
  expect(["intake_done", "summary_ready"], "a message after the flag must not reopen the intake").toContain(await visitStatus());
  await expect
    .poll(visitStatus, { message: "the brief the wrap queued for the office", ...DRAINED })
    .toBe("summary_ready");

  // §2.5 also stops the interview on the *reload*, not just in the response: the page the patient comes
  // back to must not hand them a composer again.
  await page.reload();
  await expect(page.locator(".sweetie-flagged-card")).toBeVisible(LOADED);
  await expect(page.getByLabel("Reply to Sweetie")).toHaveCount(0);
  await expect(page.locator(".sweetie-composer-stopped")).toBeVisible();
});

/**
 * The other state of the same card: with glucose it still reaches the summary (T141, design §2.5, §2.7).
 *
 * §2.5 "ends with the patient's summary link" and T66 put that link on this card, second to the office
 * instruction. T141 is only about the condition, so the path that was always right is asserted beside the
 * one that was not — a fix that simply dropped the anchor would satisfy the test above and take §2.5's
 * link with it, silently. This is the pairing e2e/flows.spec.ts already holds the skip link to.
 */
test("a flagged check-in with glucose still offers the summary §2.5 ends with", async ({ page }) => {
  await signInAsDemo(page);
  const email = patientEmail("E2E Flagged Glucose");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Flagged Glucose", email, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);

  await verifyLink(page, booked.token, email);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // The one difference from the test above: this visit has readings. clarity_window.csv is the fixture the
  // single-day test uses — 84 of them inside one day. Multipart, so postJson does not fit; the header is
  // the one it would have added (§10.8). The reload brings the new status into the page, since the upload
  // went round the back of it rather than through the Dexcom button.
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token: booked.token,
      kind: "dexcom",
      file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: readFileSync("data/fixtures/clarity_window.csv") },
    },
  });
  expect(uploaded.ok(), `POST /api/upload: ${await uploaded.text()}`).toBeTruthy();
  await page.reload();

  const input = page.getByLabel("Reply to Sweetie");
  await input.fill("I had chest pain yesterday evening and it really scared me.");
  await input.press("Enter");

  const flaggedCard = page.locator(".sweetie-flagged-card");
  await expect(flaggedCard).toBeVisible(LOADED);
  // §2.5's instruction is still the headline, and the summary is still the second thing on the card (T66).
  await expect(flaggedCard.locator("strong")).toContainText(/call .+'s office today/i);
  await expect(flaggedCard.locator(".sweetie-flagged-kept")).toHaveCount(0);
  const summary = flaggedCard.getByRole("link", { name: /shared so far/i });
  await expect(summary).toHaveAttribute("href", `/patient/${booked.token}`);
  await expectTranscriptUncut(page, "the stopped check-in with glucose");
  await shot(page, "sweetie-flagged-stopped-glucose", WHOLE_PAGE);

  // And it lands on the glucose the patient shared rather than on the invitation to go and share some,
  // which is the round trip the whole module exists to prevent.
  await summary.click();
  await expect(page).toHaveURL(new RegExp(`/patient/${booked.token}$`), LOADED);
  await expect(EYEBROW(page)).toBeVisible(LOADED);
  await expect(page.locator(".patient-summary-content")).not.toContainText(/first chapter/i);
  await expect(
    page.locator(".patient-report-card", { has: page.getByRole("heading", { name: "Your glucose", exact: true }) }),
  ).toBeVisible();
});

// T41 (design §2.7, §6): every visit type, not just the one the flow above books. The labels are written out
// here rather than imported from lib/visits.ts on purpose — a test that reads the same table as the page
// would still pass if the page printed the id, and would pass again if a label were quietly reworded.
const VISIT_TYPE_LABELS = [
  { id: "follow_up", label: "Follow-up" },
  { id: "new_patient", label: "New patient" },
  { id: "medication", label: "Medication check" },
  { id: "post_hospital", label: "After a hospital or ER visit" },
  { id: "annual", label: "Annual review" },
];

test("patient summary names the visit type in words, for every visit type", async ({ page }) => {
  // Six patient journeys in one test — book, verify, read the chip — so the per-test ceiling is the floor
  // here rather than the budget. e2e/journey.spec.ts raises its own for the same reason.
  test.setTimeout(Math.max(180_000, test.info().timeout));

  // Booking is staff's job and needs their session (§5.2); the summaries below are opened as the patient.
  await signInAsDemo(page);

  // A visit with no type at all is the fallback case: visitLabel() answers "Visit", and the chip has to be
  // there saying so rather than vanishing and leaving the row a column short. Booking validates visitType
  // against the same table (lib/visitIntake.ts), so an unrecognised id cannot be created through the API —
  // null is the only way in, and it is the same branch of visitLabel().
  const cases: { id: string | null; label: string }[] = [...VISIT_TYPE_LABELS, { id: null, label: "Visit" }];

  for (const { id, label } of cases) {
    const name = `E2E Type ${id ?? "none"}`;
    const email = patientEmail(name);
    const booked = await (
      await postJson(page.request, "/api/book", { name, email, visitType: id, reason: "checking the chip", channel: "none" })
    ).json();
    expect(booked.token, `booking a ${id ?? "typeless"} visit: ${booked.error ?? ""}`).toBeTruthy();

    // The summary sits behind the same code screen as the intake (§2.3, §5.3, components/VerifyGate.tsx), and
    // the gate is a server component — without the verified session the page's markup never arrives, so there
    // is no chip to read. Verified through the API rather than the three screens because page.request shares
    // the browser's cookie jar: the session lands where the goto below needs it, in one call instead of six.
    await verifyByApi(page.request, booked.token, email);

    await page.goto(`/patient/${booked.token}`);
    await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
    const meta = page.locator(".patient-summary-meta");
    await expect(meta, `the chip for ${id ?? "a visit with no type"}`).toContainText(label);
    // And the id itself is nowhere in the row. toContainText matches a string case-sensitively, which is what
    // makes this work for `medication` and `annual`: both are prefixes of their own label, but the label
    // capitalises them, so the lowercase id only matches if the raw column value is what got printed.
    if (id) await expect(meta, `the raw id should not reach the chip for ${id}`).not.toContainText(id);
    // One screenshot, of the longest label there is: "After a hospital or ER visit" is the chip most likely to
    // wrap badly or push the row out of the hero, and at 375px the row is capped at 230px (§6.5).
    if (id === "post_hospital") await shot(page, "patient-summary-visit-type");
  }
});

// T80 (design §2.7, and the rule T60 put in lib/plural.ts): the patient's own summary counts things, so its
// nouns have to agree with its numbers. The single-day case is the one nothing exercised — every other
// patient-summary test here uploads the seven-day sample and takes the plural path — and it is the common
// case rather than an edge one: lib/bundle.ts floors `days` at 1, so a patient who uploads the day before
// their visit, which is when they are told to, lands on it every time.
test("patient summary: one day of readings reads \"1 day\", not \"1 days\"", async ({ page }) => {
  // Booking is staff's job and needs their session (§5.2); the summary below is read as the patient.
  await signInAsDemo(page);
  const email = patientEmail("E2E One Day");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E One Day", email, visitType: "follow_up", reason: "a single day of data", channel: "none" })
  ).json();
  expect(booked.token, `booking the single-day visit: ${booked.error ?? ""}`).toBeTruthy();

  // Verified through the API for the same reason as the sweep above: page.request shares the browser's
  // cookie jar, so the patient session lands where the goto needs it (§5.3).
  await verifyByApi(page.request, booked.token, email);

  // clarity_window.csv is 84 readings inside one day — the fixture e2e/review.spec.ts uses to assert the
  // provider half of this same rule. Multipart, so postJson does not fit; the header is the one it would
  // have added (§10.8).
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token: booked.token,
      kind: "dexcom",
      file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: readFileSync("data/fixtures/clarity_window.csv") },
    },
  });
  expect(uploaded.ok(), `POST /api/upload: ${await uploaded.text()}`).toBeTruthy();

  await page.goto(`/patient/${booked.token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);

  // The "Week at a glance" tile. MiniStat renders the number and its noun as two elements, so they are
  // asserted as two: `detail` is the whole of the last line, and it read the literal "days" before T80.
  const history = page.locator(".patient-mini-stat", { hasText: "History" });
  await expect(history.locator("strong"), "the history count").toHaveText("1", LOADED);
  await expect(history.locator("small"), "the history noun").toHaveText("day");

  // And the glucose card's pill, the other site — one text node, so the count and its noun are asserted
  // together, grouped the way lib/plural.ts groups them. The card is found by its heading and not by
  // `hasText`: the time-in-range card above it opens "Your glucose was between 70 and 180 for ...", so a
  // text filter matches that one first and it has no pill to read.
  const glucoseCard = page.locator(".patient-report-card", {
    has: page.getByRole("heading", { name: "Your glucose", exact: true }),
  });
  await expect(glucoseCard.locator(".patient-card-heading > span")).toHaveText("84 readings");

  // The negative half, like e2e/review.spec.ts's on the provider side, so the defect cannot come back by
  // another route: nowhere in the patient's own report does a 1 carry a plural. The single-*reading* case
  // is the same call to countOf in the same line, and lib/plural.test.ts is what owns it.
  await expect(page.locator(".patient-summary-content"), "a count agrees with its noun").not.toContainText(/\b1 (days|readings)\b/);

  // T100 (§2.7): and the sentence above that tile names the same span the tile does. It read "for 76% of
  // the week" on this very summary — a claim about the data, next to a History tile saying 1 day — until
  // daySpan() in lib/plural.ts took the span from stats.days. The negative half is what keeps the literal
  // from coming back: on one day of readings, nothing in this card calls the span a week.
  const range = page.locator(".patient-range-copy");
  await expect(range, "the time-in-range sentence names the span it was computed over").toContainText(
    /% of the day you shared/,
  );
  await expect(range, "one day of data is never \"the week\"").not.toContainText(/the week/i);

  // T114 (§2.7, §7): the four other sites on this path that still spelled the span as a week — the heading
  // over the model's patterns, the card shown while Sour is still running, and the two lines of the prompt
  // behind those patterns (lib/prompts.ts, lib/sourRun.ts). The first two take `stats.days` through
  // spanNoun() in lib/plural.ts, the way the sentence above takes it through daySpan(); the prompt is handed
  // the same number, so a narrative the page cannot correct is never asked about a week it was not given.
  //
  // One negative assertion over the whole card rather than one per site, which is the point of it: the
  // patterns card needs a non-empty `patterns` to render at all and this suite runs with no model key, so
  // naming the two headings here would assert on which of them happened to be on screen. Whichever is,
  // nothing in the patient's own report calls one day of readings a week. The stat row's aria-label is
  // still out of reach, an attribute rather than text; the hero eyebrow is asserted below, outside this
  // locator because `.patient-summary-hero` is not inside `.patient-summary-content`.
  //
  // The bare noun rather than "your week"/"the week" (Review T114): the point of a negative assertion here
  // is that the literal cannot come back by a route nobody listed, and an article is exactly the sort of
  // thing a reword changes — "a week", "this week", "the past week" and "1 week" all say the same wrong
  // thing about 84 readings and all slip past a pattern that pins the article. Nothing legitimately says
  // "week" inside this card on a visit that has data: the only such string in `.patient-summary-content`
  // is the Connect-Dexcom empty state, which this visit's upload means is not rendered.
  await expect(
    page.locator(".patient-summary-content"),
    "one day of data is never a week, by any route or any article",
  ).not.toContainText(/week/i);

  // T123 (§2.7): and the hero above all of it, which was the one line on this page that rendered the same
  // string whatever arrived. "YOUR WEEK WITH SWEETIE" sat in the same 1280px frame as "the day you shared"
  // and "HISTORY 1 day" in T114's own committed evidence and went unread, so it is asserted here, where
  // the frame that caught it is taken. Uppercase in the DOM like every other `.ss-eyebrow` — the CSS
  // transform is the same either way, and a test should read what the markup says.
  await expect(EYEBROW(page), "the hero names the span that arrived").toHaveText("YOUR DAY WITH SWEETIE");

  // The per-project default rather than WHOLE_PAGE (e2e/shot.ts): the desktop gets the document, and the
  // phone gets one screenful, with the overview scrolled to the top of it — a whole-page phone shot of this
  // screen is the one §12.3 size gate already has an exception open for. The overview rather than the stat
  // row alone (T100): the claim and the tile that contradicted it are the two halves of one bug, and on a
  // 375px phone they stack, so a frame that starts at the stat row is a picture of the half that was right.
  await shot(page, "patient-summary-single-day", { scrollTo: ".patient-overview" });

  // And the other end of the same page, which is where T114's two sites are. SCREENFUL on both projects
  // with the footer at the bottom edge: the desktop default would shoot the document again, and the phone
  // default is anchored on the overview above. `block: "end"` is what puts the foot in frame rather than
  // the top of the footer with the cards above it off-screen.
  await shot(page, "patient-summary-single-day-foot", {
    ...SCREENFUL,
    scrollTo: ".patient-summary-footer",
    block: "end",
  });
});

// T15 (design §7.1, §7.2): the other side of reuse. A summary is only reusable while the inputs are the ones
// it was made from, so a file arriving afterwards has to be visible as such — the chip says the summary is
// out of date, and Regenerate really writes a new one rather than handing back the saved pair.
test("a file arriving after a summary makes it out of date, and regenerating writes a new one", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  // Booking is staff's job and needs the session (§5.2, T06), so it goes through the signed-in page. The
  // uploads below do not use that session: a patient's credential is the token in their link plus the
  // verified session it earns (§5.3, T08), which is what the address below is for.
  const email = patientEmail("E2E Fresh Data");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Fresh Data", email, visitType: "follow_up", reason: "spikes after dinner", channel: "none" })
  ).json();
  expect(booked.token).toBeTruthy();
  // The uploads below go through `request`, so that is the context the patient session has to land in (§5.3).
  await verifyByApi(request, booked.token, email);

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

// T82 (design §2.5, §2.7): the patient's "Where" column, in both the shapes a patient can put it in.
//
// §2.5 makes the data panel optional and Sweetie stops offering the Timeline upload once it is declined, so
// "no place is known for any rise" is an ordinary path and not an edge case — and the column used to fill
// every row of it with lib/match.ts's "no matching visit". The two tests below are the two shapes, each
// framed on the card so the committed screenshot shows the table rather than the hero above it, and each
// run in both projects so §6.5's width gets the table it is about (the phone is where a third column has
// least room, and where a column that should not be there costs the most).

/** A verified patient of their own, with the exports this shape needs already shared (§3.3, §5.3). */
async function patientWithUploads(page: Page, who: string, shares: readonly (readonly [string, string])[]) {
  // Booking is staff's job and needs their session (§5.2); the summary is read as the patient.
  await signInAsDemo(page);
  const email = patientEmail(who);
  const booked = await (
    await postJson(page.request, "/api/book", { name: who, email, visitType: "follow_up", reason: "a week of readings", channel: "none" })
  ).json();
  expect(booked.token, `booking ${who}: ${booked.error ?? ""}`).toBeTruthy();

  // Through the API for the same reason as the sweep above: page.request shares the browser's cookie jar,
  // so the patient session lands where the goto below needs it (§5.3).
  await verifyByApi(page.request, booked.token, email);

  for (const [kind, path] of shares) {
    // Multipart, so postJson does not fit; the CSRF header is the one it would have added (§10.8).
    const name = path.split("/").pop()!;
    const uploaded = await page.request.post("/api/upload", {
      headers: { "x-csrf-token": await csrfToken(page.request) },
      multipart: {
        token: booked.token,
        kind,
        file: { name, mimeType: name.endsWith(".json") ? "application/json" : "text/csv", buffer: readFileSync(path) },
      },
    });
    expect(uploaded.ok(), `${kind} upload: ${await uploaded.text()}`).toBeTruthy();
  }

  await page.goto(`/patient/${booked.token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  return booked.token as string;
}

/** How many of this visit's rises the matcher placed, read from the bundle the page itself renders. */
async function placedRises(page: Page, token: string) {
  const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
  return { placed: bundle.spikes.filter((s: { visit?: unknown }) => s.visit).length, total: bundle.spikes.length };
}

test("patient summary: no Timeline shared, so nothing reports a place the patient never gave", async ({ page }) => {
  const token = await patientWithUploads(page, "E2E No Places", [["dexcom", "data/dexcom_clarity_sample.csv"]]);

  const { placed, total } = await placedRises(page, token);
  expect(total, "this week has rises to show").toBeGreaterThan(0);
  expect(placed, "and not one of them has a place").toBe(0);

  // The table is When and Rise. Not a third column of "no matching visit", which is the matcher's word for
  // it (lib/match.ts) on the one page written for the patient, and whose one noun — "visit" — already means
  // the appointment they are preparing for (§4.4).
  const rises = page.locator(".patient-spikes");
  await expect(rises.getByRole("columnheader")).toHaveText(["When", "Rise"]);
  await expect(page.locator(".patient-summary-content")).not.toContainText(/no matching visit/i);

  // And the caption over the chart does not promise the column that is not there. Both read one predicate
  // in lib/spikePlaces.ts, so they cannot drift apart.
  await expect(page.locator(".patient-summary-content")).not.toContainText(/where you had just been/i);

  // T100 (§2.7): the other side of the single-day assertion above. dexcom_clarity_sample.csv really is
  // seven days, so here the sentence keeps the wording the page was written with, and the figure and its
  // span still agree — daySpan() branches on seven rather than defaulting to it.
  await expect(page.locator(".patient-range-copy"), "seven days of readings are \"the week\"").toContainText(
    /% of the week/,
  );

  // T123 (§2.7): the seven-day half of the eyebrow pair. spanNoun() branches on seven rather than
  // defaulting to it, so the hero a patient with a full week sees is the string the page has always
  // shown — this is the assertion that keeps the fix for one day from changing the case it was right for.
  await expect(EYEBROW(page), "a week of readings is still a week").toHaveText("YOUR WEEK WITH SWEETIE");

  if (test.info().project.name === "mobile") await expectNoHorizontalScroll(page, "the patient summary, no places");
  await shot(page, "patient-summary-no-places", { scrollTo: ".patient-spikes" });

  // T114: the seven-day half of the pair above, framed the same way, so the two foot shots are a
  // before-and-after of one part of one page at the two spans rather than two different parts.
  await shot(page, "patient-summary-seven-day-foot", {
    ...SCREENFUL,
    scrollTo: ".patient-summary-footer",
    block: "end",
  });
});

test("patient summary: a rise with no place says so in the patient's words, not the matcher's", async ({ page }) => {
  // The same two samples e2e/mobile.spec.ts shares with its own patient: matchSpikesToVisits places some of
  // the week's rises against the Timeline and leaves the rest alone.
  const token = await patientWithUploads(page, "E2E Places", [
    ["dexcom", "data/dexcom_clarity_sample.csv"],
    ["timeline", "data/timeline_sample.json"],
  ]);

  // Read first, so the test knows which shape it is asserting rather than hoping. If the samples ever drift
  // so that every rise is placed, this says so here instead of failing further down on a missing word.
  const { placed, total } = await placedRises(page, token);
  expect(placed, "some rises are placed").toBeGreaterThan(0);
  expect(placed, "and some are not — this is the mixed shape").toBeLessThan(total);

  // So the column has something to say and is drawn, and the caption may promise places again.
  const rises = page.locator(".patient-spikes");
  await expect(rises.getByRole("columnheader")).toHaveText(["When", "Rise", "Where"]);
  await expect(page.locator(".patient-summary-content")).toContainText(/where you had just been/i);

  // The rows it cannot place answer in the patient's own words. "visit" is barred outright, for the reason
  // above: on §2.7's page that word is their appointment, never a place they went.
  await expect(rises).toContainText("not sure");
  await expect(rises, "the matcher's vocabulary").not.toContainText(/no matching visit/i);
  await expect(rises, "the one word that means something else on this page").not.toContainText(/visit/i);

  // T128 (§2.7): and so do the rows it *did* place against a stop the export never named. These two
  // samples are the whole of that case — data/timeline_sample.json carries coordinates and nothing here
  // uploads the hand labels, so every placed rise is an unnamed stop — and the coordinates used to be the
  // cell. The chart says the same words over its markers, because both read lib/spikePlaces.ts.
  await expect(rises, "the patient's word for a stop with no name").toContainText(UNNAMED_PLACE);
  await expect(page.locator(".patient-chart-wrap").first(), "the marker labels over the same rises").toContainText(UNNAMED_PLACE, LOADED);
  await expectNoCoordinates(page, "the patient summary, mixed places");

  if (test.info().project.name === "mobile") await expectNoHorizontalScroll(page, "the patient summary, mixed places");
  await shot(page, "patient-summary-places", { scrollTo: ".patient-spikes" });
});

/**
 * The summary's loading card, which is the one state of §2.7's page that had no assertion on it at all —
 * and is how "your week" outlived T100, T114, T116 and T123 (T132, design §2.5, §2.7).
 *
 * `bundle` is null here, so nothing is known: there is no `stats.days` to read a span off, and the page
 * used to guess one. That made it contradict itself across a single navigation — the single-day visit below
 * resolved to "YOUR DAY WITH SWEETIE" over a HISTORY tile reading "1 day", under a card that had just
 * promised a week. So the card takes the word the hero's own nothing-shared branch settled on.
 *
 * The state is transient by nature, which is exactly why it went unasserted: the comment above the
 * patient-summary shot in this file records a loose text check matching the spinner and the screenshot
 * being of it. Holding the response rather than racing it is what makes this deterministic — the route is
 * stalled, the card is read, and only then is the response let through, so the same test also shows the
 * card is really a stage of this page and not a dead branch. The ticket's own reproduction is the network
 * throttled; this is that, made exact.
 */
test("patient summary: the loading card names no span, because nothing is known yet", async ({ page }) => {
  await signInAsDemo(page);
  const email = patientEmail("E2E Loading");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Loading", email, visitType: "follow_up", reason: "what the card says while it loads", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);
  await verifyLink(page, booked.token, email);

  // Hold GET /api/patient/<token> until the card has been read. `release` is resolved by the test, so the
  // wait is on this test's own order of events and not on a timer that a slow box could outrun (T95).
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A regex rather than a glob: `**` around a path segment is the kind of pattern that silently matches
  // nothing, and a route that never intercepts would leave this test asserting the loaded page instead of
  // the card — passing for the wrong reason.
  await page.route(/\/api\/patient\//, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`/patient/${booked.token}`);
  const card = page.locator(".patient-state-card");
  await expect(card).toBeVisible(LOADED);
  await expect(card).toHaveText("Sweetie is getting your check-in ready…");
  // The rule, not just the literal: the same noun pattern lib/dexcomHint.test.ts pins, so a reword that
  // puts any span back fails here rather than only an exact return of "your week".
  expect(await card.textContent(), "the summary's loading card").not.toMatch(/\b(hours?|days?|weeks?|months?)\b/i);

  // And it is this page's loading stage: letting the response through resolves the same navigation into the
  // summary itself, so the card above was not a branch nothing reaches.
  release();
  await expect(EYEBROW(page)).toBeVisible(LOADED);
  await expect(card).toHaveCount(0);
});

/**
 * Skipping the rest of the questions with nothing shared but a typed answer (T133, T137, design §2.5, §2.7).
 *
 * The chat's half of the ticket. Whether to offer the skip at all is decided correctly — there is nothing
 * to skip to until the patient has answered or shared something — but the same condition also wrote the
 * link, the goodbye and the destination of the press, and `turns > 0` satisfies all three on its own. So
 * a patient who typed one message and uploaded nothing read "Skip the rest and view my week", was
 * answered "You can view your week now", and was taken to a `/patient/<token>` that renders on
 * `status.hasDexcom` and had no reading to render.
 *
 * Driven through the page rather than by posting the event, because the link's words are part of what was
 * wrong and where the press lands is the rest of it. T133 fixed the words and read the goodbye out of
 * `GET /api/sweetie`, because the navigation took the patient off the page before the reply could paint —
 * the transcript was the only honest place left to look at it. T137 removed that navigation, so the
 * goodbye is asserted where the patient actually meets it: on the screen they are still on.
 */
test("the skip link and goodbye promise no summary to a check-in with nothing shared", async ({ page }) => {
  await signInAsDemo(page);
  const email = patientEmail("E2E Skip Empty");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Skip Empty", email, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);
  await verifyLink(page, booked.token, email);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // One answer and no upload, which is the state the ticket is about. The reply landing is one more
  // Sweetie bubble, the signal e2e/flows.spec.ts's two-question test waits on.
  const sweetieSaid = page.locator(
    ".sweetie-messages .sweetie-message-row:not(.sweetie-message-patient) .sweetie-message:not(.sweetie-typing)",
  );
  const said = await sweetieSaid.count();
  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  await input.fill("Mornings are the worst of it and I want to know whether to change anything.");
  await input.press("Enter");
  await expect(sweetieSaid).toHaveCount(said + 1, LOADED);

  // Asserted rather than assumed: a visit that somehow had readings in it would make everything below
  // pass for the wrong reason, since with glucose the promise is the correct thing to make.
  const before = await (await page.request.get(`/api/sweetie?token=${booked.token}`)).json();
  expect(before.status.hasDexcom, "nothing was uploaded").toBe(false);
  expect(before.status.hasWhoop || before.status.hasLocation, "nothing was uploaded").toBe(false);

  // The link is on the screen, because the patient has answered something — and it no longer offers a
  // week, or a view of anything. The span pattern is lib/dexcomHint.test.ts's, so a reword fails here too.
  const skip = page.locator(".sweetie-skip-link");
  await expect(skip).toBeVisible(LOADED);
  await expect(skip).toHaveText("Skip the rest of the questions");
  const label = await skip.textContent();
  expect(label, "the skip link").not.toMatch(/\b(hours?|days?|weeks?|months?)\b/i);
  expect(label, "the skip link").not.toMatch(/view/i);

  await skip.click();
  // The press is honoured — the intake wraps, so the link goes and the questions stop — and it leaves the
  // patient here. The label offered no view of anything, and `skipDestination` (lib/summaryPromise.ts) is
  // the same answer for where the press goes. This is not the refusal branch either: that one keeps them
  // in the chat with an inline hint and writes no goodbye at all, which the assertions below separate it
  // from.
  await expect(page.locator(".sweetie-skip-link")).toHaveCount(0, LOADED);
  await expect(page).toHaveURL(new RegExp(`/s/${booked.token}$`));
  // Scoped to the sidebar, where the refusal's inline hint is rendered: App Router puts a permanently
  // empty `role="alert"` at the end of every document (its route announcer), so a page-wide count is 1 on
  // every screen in the product and asserts nothing.
  await expect(page.locator(".sweetie-chat-sidebar [role='alert']")).toHaveCount(0);

  // And the goodbye is on the screen, not only in the transcript behind it: it says what is saved and
  // offers no summary there is none of. The span pattern is lib/dexcomHint.test.ts's, as above.
  const goodbye = sweetieSaid.last();
  await expect(goodbye).toContainText(/skipped the remaining questions/i, LOADED);
  await expect(goodbye).toContainText(/saved for your care team/i);
  const spoken = await goodbye.textContent();
  expect(spoken, "Sweetie's goodbye").not.toMatch(/you can view/i);
  expect(spoken, "Sweetie's goodbye").not.toMatch(/\b(hours?|days?|weeks?|months?)\b/i);
  // Visible, and not merely present: the transcript is its own scrolling region and glides to the newest
  // message (§6.4), so this waits that glide out and fails if the goodbye is cut off at the bottom (T83).
  // It is also what makes the committed screenshot a picture of the goodbye rather than of the question
  // before it.
  await expectTranscriptUncut(page, "Sweetie's goodbye after the skip");

  // The card that now ends the transcript does not re-make, one line below the goodbye and in larger
  // type, the offer the goodbye just declined — and it is a statement rather than a link, so there is no
  // route from this screen to the empty summary at all.
  const doneCard = page.locator(".sweetie-done-card");
  await expect(doneCard).toContainText(/check-in is complete/i);
  await expect(doneCard).toContainText(/saved for your care team/i);
  await expect(doneCard, "no summary is offered where there is none").not.toContainText(/summary/i);
  await expect(page.locator(`.sweetie-conversation a[href="/patient/${booked.token}"]`)).toHaveCount(0);

  // And the rail agrees with the rest of the screen about what just happened (T142, §2.5, §6.5). One
  // answer of two, then the skip, used to read "Conversation progress 67%" over a two-thirds-full track
  // over "Your story is ready" — the number saying a third was outstanding, the track drawing it, and the
  // sentence saying it was done. T66 settled the shape for the other early ending; all three parts come
  // from lib/intakeProgress.ts now, so they cannot disagree. Asserted on both projects, because at 375px
  // the sentence was the part that was not rendered at all and the bare 67% was the whole card.
  const rail = page.locator(".sweetie-progress-card");
  await expect(rail).toContainText(/Check-in ended early/i);
  await expect(rail, "no percentage beside a check-in that stopped short").not.toContainText(/%/);
  await expect(page.locator(".sweetie-progress-track"), "and so no track either").toHaveCount(0);
  await expect(rail).not.toContainText(/your story is ready/i);
  // The sentence is what the card has instead of the number, so §6.5 wants it on the phone as well.
  const railNote = rail.locator("small");
  await expect(railNote).toBeVisible();
  await expect(railNote).toContainText(/skipped the rest/i);
  await expect(railNote).toContainText(/saved for your care team/i);

  await shot(page, "sweetie-skip-no-glucose", WHOLE_PAGE);

  // What the route committed is what the patient read, so the two halves of §2.5's goodbye cannot drift:
  // the page is not showing a message of its own making.
  const after = await (await page.request.get(`/api/sweetie?token=${booked.token}`)).json();
  const committed = after.messages.filter((m: { role: string }) => m.role === "sweetie").at(-1).content as string;
  expect(committed, "the goodbye the route committed").toBe(spoken);
});

/**
 * The other half of the same press: with glucose it still reaches the summary (T137, design §2.5, §2.7).
 *
 * T133 settled this pairing — `skipLinkLabel(true)` offers "Skip the rest and view my glucose" and
 * `/patient/<token>` renders exactly that — and T137 moved the destination of the press behind the same
 * predicate. A fix that simply stopped navigating would satisfy the test above and take this path with
 * it, silently, so the path that was always right is asserted beside the one that was not.
 */
test("the skip link with glucose still goes to the summary it offers", async ({ page }) => {
  await signInAsDemo(page);
  const email = patientEmail("E2E Skip Glucose");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Skip Glucose", email, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);
  await verifyLink(page, booked.token, email);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // The one difference from the test above: this visit has readings. clarity_window.csv is the same
  // fixture the single-day test uses. Multipart, so postJson does not fit; the header is the one it would
  // have added (§10.8). The reload is what brings the new status into the page, since the upload went
  // round the back of it rather than through the Dexcom button.
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token: booked.token,
      kind: "dexcom",
      file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: readFileSync("data/fixtures/clarity_window.csv") },
    },
  });
  expect(uploaded.ok(), `POST /api/upload: ${await uploaded.text()}`).toBeTruthy();
  await page.reload();

  // Glucose is enough on its own to put the link on the screen — nothing has been answered here — and the
  // label is the one that offers the summary.
  const skip = page.locator(".sweetie-skip-link");
  await expect(skip).toBeVisible(LOADED);
  await expect(skip).toHaveText("Skip the rest and view my glucose");

  await skip.click();
  await expect(page).toHaveURL(new RegExp(`/patient/${booked.token}$`), LOADED);
  // And the destination renders what the label named, rather than the empty card that asks for it — which
  // is the pairing the whole module exists to keep true.
  await expect(EYEBROW(page)).toBeVisible(LOADED);
  await expect(page.locator(".patient-summary-content")).not.toContainText(/first chapter/i);
  await expect(
    page.locator(".patient-report-card", { has: page.getByRole("heading", { name: "Your glucose", exact: true }) }),
  ).toBeVisible();
});
