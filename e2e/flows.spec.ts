import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { expectNoHorizontalScroll } from "./mobile";
import { patientEmail, verifyByApi, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// Both customer flows in scripted mode, with a screenshot of every screen. Screens are named so the builder and
// reviewer routines can find them: e2e/screenshots/<project>-<name>.png. e2e/shot.ts decides how much of the
// page each one gets: the patient screens are the page, the dashboard is one screenful with its table in it.. e2e/shot.ts decides how much of the
// page each one gets: the patient screens are the page, the dashboard is one screenful with its table in it.

// Waits for a client fetch to paint, not for app logic: the page renders its shell first and fills in after. A
// slow runner can take longer than the 5s default to come back, so these get their own budget.
const LOADED = { timeout: 30_000 };

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
  // The row this test is about, centred in the shot: on a phone the dashboard is as tall as the
  // practice's visit list, and one screenful of somebody else's rows answers nothing (T57).
  await shot(page, "provider-dashboard", {
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
  await shot(page, "provider-dashboard-booked", { scrollTo: bookedRow, block: "center" });

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
  await expect(page.locator(".sour-degraded-note")).toContainText(/not enabled for this practice/i, LOADED);
  // §2.7, §10.6: what the clinician is told is "ask your administrator", never the name of a variable, and
  // the patient reads a version of this screen.
  await expect(page.locator(".sour-brief")).not.toContainText(/OPENAI|API_KEY/i);
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
    }, { message: "the run reported back", timeout: 20_000 })
    .toBe("done");
  expect(after.providerSummaryAt, "the saved pair came back rather than a third one being written").toBe(before.providerSummaryAt);
  expect(after.patientSummaryAt).toBe(before.patientSummaryAt);
  expect(after.summaryStale).toBe(false);
});

test("patient flow: Sweetie two questions in scripted mode, then summary", async ({ page }) => {
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
  await shot(page, "sweetie-done", WHOLE_PAGE);

  // page.request, not request: the verified session lives in the browser's cookie jar (§5.3).
  const bundle = await (await page.request.get(`/api/patient/${booked.token}`)).json();
  expect(bundle.status.answered).toBeGreaterThanOrEqual(1);

  await page.goto(`/patient/${booked.token}`);
  // The loading card says "getting your week ready", which the old loose text check matched, so the screenshot was
  // of a spinner. Assert on something only the loaded summary has.
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  // T41 (§2.7, §6): the chip row names the visit in words. This visit was booked as `follow_up`, and the row
  // read exactly that until the page started going through visitLabel() — a column value on the one screen
  // written for the patient. Asserted here as well as in the sweep below because this is the row the
  // screenshot is of.
  await expect(page.locator(".patient-summary-meta")).toContainText("Follow-up");
  await expect(page.locator(".patient-summary-meta")).not.toContainText("follow_up");
  await shot(page, "patient-summary", WHOLE_PAGE);
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
  // together, grouped the way lib/plural.ts groups them.
  const glucoseCard = page.locator(".patient-report-card", { hasText: "Your glucose" }).first();
  await expect(glucoseCard.locator(".patient-card-heading span")).toHaveText("84 readings");

  // The negative half, like e2e/review.spec.ts's on the provider side, so the defect cannot come back by
  // another route: nowhere in the patient's own report does a 1 carry a plural. The single-*reading* case
  // is the same call to countOf in the same line, and lib/plural.test.ts is what owns it.
  await expect(page.locator(".patient-summary-content"), "a count agrees with its noun").not.toContainText(/\b1 (days|readings)\b/);

  // The per-project default rather than WHOLE_PAGE (e2e/shot.ts): the desktop gets the document, and the
  // phone gets one screenful with the stat row scrolled to the top of it — the tile this ticket is about is
  // well below a 375px fold, and a whole-page phone shot of this screen is the one §12.3 size gate already
  // has an exception open for.
  await shot(page, "patient-summary-single-day", { scrollTo: ".patient-mini-stats" });
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
