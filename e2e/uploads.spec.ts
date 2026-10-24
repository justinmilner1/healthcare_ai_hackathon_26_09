import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { patientEmail, verifyByApi, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T11 (design §3.3, §9.1): the upload gates and the storage adapter, through the real route. The file a
// patient picks is checked for size and shape before any parser sees it, the bytes go to the storage
// adapter, and the row keeps the key — so these drive the intake screen rather than calling lib/ directly.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");
const timeline = () => readFileSync(join(process.cwd(), "data", "fixtures", "timeline_android.json"), "utf8");

/**
 * A visit to upload into, booked the way a visit is booked: by someone at the practice, signed in, because
 * booking is behind the staff role (T06, §5.2). The provider's session is dropped again before the test
 * touches the patient's side, and the address is where the patient's six-digit code goes (T08, §5.3) — the
 * caller verifies with it, in the browser or through the request context, whichever it drives.
 */
async function bookVisit(page: Page, name: string) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  // postJson adds the CSRF header the way the app's own pages do (design §10.8, e2e/api.ts).
  const booked = await (
    await postJson(page.request, "/api/book", { name, email, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token).toBeTruthy();
  await signOutOfBrowser(page);
  return { ...(booked as { token: string; visitId: string }), email };
}

test("intake uploads: a real export is stored, the wrong file is refused in plain language", async ({ page }) => {
  const { token, email } = await bookVisit(page, "E2E Uploader");
  await verifyLink(page, token, email);
  await page.goto(`/s/${token}/intake`);
  // The intake screen opens on its welcome step; the data sources are the step after it.
  await page.getByRole("button", { name: /Let's get started/i }).click();

  const dexcomInput = page.getByLabel(/Upload Dexcom file/i);
  await expect(dexcomInput).toBeAttached(LOADED);
  // T71 (§2.5): with no credentials set — how this suite and the demo run — the hint under the Dexcom card
  // offers the patient the path that works instead of reporting the deployment to them.
  await expect(page.getByText(/Upload your Clarity CSV export/)).toBeVisible(LOADED);
  await dexcomInput.setInputFiles({ name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) });
  // The card states what was stored, which only happens after the route parsed the file and the adapter
  // wrote the bytes: the response the card reads comes after both.
  await expect(page.getByText(/records securely added/i)).toBeVisible(LOADED);
  // ...and the hint follows the upload rather than contradicting it (T71).
  await expect(page.getByText(/Your Clarity CSV is in\./)).toBeVisible(LOADED);
  await expect(page.getByText(/Upload your Clarity CSV export/)).toHaveCount(0);

  // A Takeout zip is the mistake patients actually make. It is named for what it is, not fed to a CSV parser,
  // and the Dexcom data already connected stays connected.
  const whoopInput = page.getByLabel(/Upload WHOOP file/i);
  await whoopInput.setInputFiles({ name: "Takeout.zip", mimeType: "application/zip", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]) });
  await expect(page.getByText(/unzip it and upload the file inside/i)).toBeVisible(LOADED);
  await expect(page.getByText(/records securely added/i)).toBeVisible();

  // T49 (§6.1, §6.4): the one pill a patient sees when something they did went wrong. Its marker is an
  // icon element like the sibling states', not a bare "!" that the pill's uppercase ran into the word;
  // and the change is announced, naming the source that failed and that it can be retried.
  await expect(page.getByText("!Try again")).toHaveCount(0);
  await expect(
    page.locator('[role="status"]', { hasText: "WHOOP could not be connected. Try again." }),
  ).toHaveCount(1);

  await shot(page, "patient-intake-uploads", WHOLE_PAGE);
});

test("upload gates: oversized, wrong format, and empty files never reach a parser", async ({ page, request }) => {
  const { token, email } = await bookVisit(page, "E2E Gatekeeper");
  // The uploads below go through `request`, so that is the context the patient session has to land in (§5.3).
  await verifyByApi(request, token, email);
  // A multipart upload is state-changing too, so it carries the same CSRF header the intake page sends.
  const post = async (kind: string, name: string, buffer: Buffer, mimeType = "text/csv") =>
    request.post("/api/upload", {
      multipart: { token, kind, file: { name, mimeType, buffer } },
      headers: { "x-csrf-token": await csrfToken(request) },
    });

  // §9.1 size cap. Refused on the declared size, before the bytes are read or parsed.
  const oversized = await post("dexcom", "two_years.csv", Buffer.alloc(MAX_UPLOAD_BYTES + 1024, "a"));
  expect(oversized.status()).toBe(413);
  expect((await oversized.json()).error).toMatch(/most we can take is 20\.0 MB/);

  // The right file on the wrong button: a wrong-file sentence, not a parse error.
  const wrongKind = await post("dexcom", "Timeline.json", Buffer.from(timeline()), "application/json");
  expect(wrongKind.status()).toBe(415);
  expect((await wrongKind.json()).error).toMatch(/JSON file, but a Dexcom Clarity export is a CSV/);

  const asTimeline = await post("timeline", "Clarity_export.csv", Buffer.from(clarity()));
  expect(asTimeline.status()).toBe(415);
  expect((await asTimeline.json()).error).toMatch(/Timeline export is a JSON file/);

  const empty = await post("dexcom", "empty.csv", Buffer.alloc(0));
  expect(empty.status()).toBe(400);
  expect((await empty.json()).error).toMatch(/empty/);

  // A well-formed CSV with no rows in it is the parser's call, and still a sentence about the file.
  const noRows = await post("dexcom", "headers_only.csv", Buffer.from("Timestamp (YYYY-MM-DDThh:mm:ss),Glucose Value (mg/dL)\n"));
  expect(noRows.status()).toBe(422);
  expect((await noRows.json()).error).toMatch(/no glucose readings in that file/);

  // JSON that is not a Timeline export: the parser's position-42 message never reaches the patient.
  const broken = await post("timeline", "Timeline.json", Buffer.from('{"semanticSegments": ['), "application/json");
  expect(broken.status()).toBe(422);
  expect((await broken.json()).error).toMatch(/could not read that as a Timeline export/);
  expect((await broken.json()).error).not.toMatch(/JSON|position|token/);

  // And the good file, so the refusals above are about the files and not about the route being broken.
  const good = await post("dexcom", "Clarity_export.csv", Buffer.from(clarity()));
  expect(good.ok()).toBeTruthy();
  expect((await good.json()).count).toBeGreaterThan(0);
});

// T72 (design §7.1, §3.4): the third trigger. The Dexcom export a patient shares after their intake has
// wrapped is what queues the run over those readings. Before T72 it deleted the saved summaries and queued
// nothing: whoever opened the provider page next paid for the run, and `notify.summary` (§2.6), which only
// `runSour` queues, never happened at all. Nothing here presses Generate or opens the brief until the job
// has already reported back.
//
// T143 moved the starting state of this test rather than its subject. The wrap no longer waits for data, so
// by the time the export arrives there is already a conversation-only brief, and what the import queues is a
// second run — over the readings, against a different input hash (lib/sourInput.ts). That is the assertion
// below: a job row that is not the wrap's, and a brief that has numbers in it where the first one had none.
//
// The message itself is one step further than this suite can see: with no model key a run saves the
// numbers-only pair and deliberately skips the notification (lib/sourRun.ts), so what the clinician is told
// is asserted where a narrator can be injected (lib/sourRun.test.ts, "queues the two links"). What was
// missing, and what this test is about, is the run.
test("a Dexcom export shared after intake wrapped queues the summary run", async ({ page, request }) => {
  // Two sign-ins, a verification and a drained queue, all behind one patient's export — so a floor under the
  // per-test ceiling, not a flat number the ceiling can overtake (playwright.config.ts, TEST_TIMEOUT_MS).
  test.setTimeout(Math.max(120_000, test.info().timeout));
  const { token, visitId, email } = await bookVisit(page, "E2E Late Export");
  // The patient's half of this test is the request context (§5.3); the clinician's is the browser.
  await verifyByApi(request, token, email);

  // Both required fields of a follow-up template, answered through the route the intake screen posts to.
  // The GET first, because that is what writes the greeting and settles the field list (lib/sweetie.ts),
  // and in scripted mode the deterministic backstop is what records the answers.
  expect((await request.get(`/api/sweetie?token=${token}`)).ok()).toBeTruthy();
  const said = [
    "My sugars run high after dinner, maybe four nights a week since I started the new job in August.",
    "Nothing else changed except the hours. No lows, but I am sleeping about six hours and feel wrung out by Friday.",
  ];
  let intake: { wrapped?: boolean } = {};
  for (const message of said) {
    const turn = await postJson(request, "/api/sweetie", { token, message });
    expect(turn.status(), await turn.text()).toBe(200);
    intake = (await turn.json()).intake;
  }
  expect(intake.wrapped, "the second answer is the turn that wraps").toBe(true);

  // Where the wrap left this visit (T143): the intake is done, there is no glucose, and the wrap queued and
  // ran a brief from the conversation alone (lib/sourQueue.ts `wrapQueuesSour`).
  //
  // Drained before the export rather than raced with it, and that is about the product and not about the
  // suite: one `sour.run` is in flight per visit (`sourJobKey`), so an upload landing while the wrap's run
  // is still going joins that run instead of getting one of its own, and what the clinician ends up with is
  // the conversation-only pair with `summaryStale` over it and §7.2's regenerate offered. Waiting here is
  // what makes the run below unambiguously the import's.
  const clinician = await signInAsDemo(page);
  const bundleNow = async () => (await page.request.get(`/api/patient/${visitId}`)).json();
  await expect
    .poll(async () => (await bundleNow()).sourJob?.status ?? "none", { message: "the run the wrap queued", ...DRAINED })
    .toBe("done");
  const before = await bundleNow();
  expect(before.visitStatus).toBe("summary_ready");
  expect(before.status.hasDexcom).toBe(false);
  expect(before.providerSummary, "the wrap's own brief, written from the conversation").toBeTruthy();
  expect(before.providerSummary.timeInRange, "with no readings behind it").toBe(0);
  const wrapJob: string = before.sourJob.id;

  // The export arrives. This is the import §7.1 asks about, through the route a Clarity upload takes.
  const shared = await request.post("/api/upload", {
    multipart: { token, kind: "dexcom", file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(shared.status(), await shared.text()).toBe(200);
  expect((await shared.json()).count).toBeGreaterThan(0);

  // A job of the import's own: read through the clinician's bundle, which is where §7.2 keeps the newest one
  // (lib/bundle.ts, latestJobForVisit). A row that is not `wrapJob` is the assertion, because the wrap's own
  // row is already there — "no new job at all" is the bug T72 was filed for. Polled because the row is
  // written while the upload's response is on its way back.
  await expect
    .poll(async () => (await bundleNow()).sourJob?.id ?? "none", { message: "a run queued by the import", ...LOADED })
    .not.toBe(wrapJob);

  // And the run finishes on its own, with nobody having opened the brief: a saved pair, the visit moved on,
  // and the job reporting done (§3.4, §4.4, §7.2).
  await expect
    .poll(async () => (await bundleNow()).sourJob?.status ?? "none", DRAINED)
    .toBe("done");
  const ran = await bundleNow();
  expect(ran.providerSummary, "the brief the clinician's link opens").toBeTruthy();
  // The numbers the import brought, where the wrap's brief had a zero: §7.1's input hash carries every
  // upload, so the export is a change of inputs and not something the saved pair dedupes against.
  expect(ran.providerSummary.timeInRange).toBeGreaterThan(0);
  expect(ran.visitStatus).toBe("summary_ready");
  // Why no message went out, in one assertion: this build has no model, which is the one reason
  // `runSour` skips `notify.summary` — not a run that never happened (§6.3, §11.3, T63).
  expect(ran.providerSummary.narrativeMissing).toBe("unconfigured");

  // And the screen behind it: the brief is ready on first open, with the chip reading Ready rather than the
  // page having queued the run itself (§7.2, app/provider/[id]/sour.tsx).
  await page.goto(`/provider/${clinician.id}?visit=${visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Late Export", LOADED);
  const chip = page.locator(".sour-job-state");
  await expect(chip).toHaveAttribute("data-phase", "ready", LOADED);
  await expect(page.locator(".sour-brief")).toContainText("new job in August");
  await shot(page, "provider-sour-from-import");
});

// The cap is 20 MB, so a file well past the size a request survives through middleware has to arrive whole.
// This is the regression guard for that: routed through middleware, a 12 MB body reached the handler
// truncated and `formData()` threw, which is why /api/upload runs its own CSRF check instead
// (CSRF_SELF_CHECKED_PATHS in lib/csrf.ts). A unit test cannot see any of that; only the running app can.
//
// The readings sit at the *end* of 11 MB of lines the Clarity parser skips, so the count is the assertion
// that the whole body arrived: a truncated upload still parses, it just loses the rows at the end. Filler
// rather than 11 MB of real readings because 400,000 of those take the server a minute to parse and store,
// and everything else in the suite is waiting on the same event loop.
test("a large export, under the cap but over what a proxied body carries, arrives whole", async ({ page, request }) => {
  const { token, email } = await bookVisit(page, "E2E Big Export");
  // The uploads below go through `request`, so that is the context the patient session has to land in (§5.3).
  await verifyByApi(request, token, email);
  const header = "Index,Timestamp (YYYY-MM-DDThh:mm:ss),Glucose Value (mg/dL)\n";
  const skipped = `${",".repeat(8)}\n`.repeat(Math.ceil((11 * 1024 * 1024) / 9));
  const readings = Array.from({ length: 100 }, (_, i) => `${i + 1},2026-10-01T${String(i % 24).padStart(2, "0")}:00:00,${100 + i}\n`).join("");
  const buffer = Buffer.from(header + skipped + readings);
  // Over the size a proxied body stopped surviving, and under the cap.
  expect(buffer.byteLength).toBeGreaterThan(10 * 1024 * 1024);
  expect(buffer.byteLength).toBeLessThan(MAX_UPLOAD_BYTES);

  const res = await request.post("/api/upload", {
    multipart: { token, kind: "dexcom", file: { name: "Clarity_long_range.csv", mimeType: "text/csv", buffer } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).count).toBe(100);
});

// §10.8 still holds for this route even though middleware does not see it: the handler runs the same check.
test("the upload route is still CSRF-protected, from inside the handler", async ({ page, request }) => {
  const { token, email } = await bookVisit(page, "E2E Forged");
  // The uploads below go through `request`, so that is the context the patient session has to land in (§5.3).
  await verifyByApi(request, token, email);
  const noToken = await request.post("/api/upload", {
    multipart: { token, kind: "dexcom", file: { name: "Clarity.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { cookie: "" },
  });
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).code).toBe("csrf_failed");
  expect(noToken.headers()["x-csrf-blocked"]).toBeTruthy();
  // And the static §10.8 headers are on it, which is what being outside the matcher could have cost.
  expect(noToken.headers()["x-frame-options"]).toBe("DENY");

  const crossSite = await request.post("/api/upload", {
    multipart: { token, kind: "dexcom", file: { name: "Clarity.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request), origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
  expect(crossSite.headers()["x-csrf-blocked"]).toContain("origin");
});
