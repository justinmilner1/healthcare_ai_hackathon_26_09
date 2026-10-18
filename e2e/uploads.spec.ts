import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { findDevMail } from "../lib/devMailbox";
import { csrfToken, postJson } from "./api";
import { MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { patientEmail, verifyByApi, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T11 (design §3.3, §9.1): the upload gates and the storage adapter, through the real route. The file a
// patient picks is checked for size and shape before any parser sees it, the bytes go to the storage
// adapter, and the row keeps the key — so these drive the intake screen rather than calling lib/ directly.

const LOADED = { timeout: 30_000 };
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");
/** Every mailbox the suite's servers write to: the inline drain happens in whichever server the queue's next
 *  request lands on, and it writes to its own (e2e/patient.ts says the same thing about the codes). */
const MAILBOXES = [MAIL_DIR, `${MAIL_DIR}-degraded`, `${MAIL_DIR}-runner`, `${MAIL_DIR}-dexcom`, `${MAIL_DIR}-demo`];
/** The "your summary is ready" message for this address, or null while none has arrived (lib/notify.ts). */
const summaryMail = (to: string) => findDevMail(MAILBOXES, to, (raw) => raw.match(/^Subject: (Your summary is ready.*)$/m)?.[1] ?? null);
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

// T72 (design §7.1, §2.6, §3.4): the third trigger. A visit whose intake wrapped with no readings has
// nothing queued — the wrapping turn's trigger is gated on the data being in — so the Dexcom export the
// patient shares afterwards is what has to queue the run. Before this ticket it deleted the saved summaries
// and queued nothing: the clinician was never emailed, and whoever opened the provider page next paid for
// the run. Nothing here presses Generate or opens the brief until the job has already reported back.
test("a Dexcom export shared after intake wrapped queues the summary run, and the clinician is told", async ({ page, request }) => {
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

  // The state this ticket is about: the intake is done and there is no glucose data, so nothing was queued.
  const clinician = await signInAsDemo(page);
  const before = await (await page.request.get(`/api/patient/${visitId}`)).json();
  expect(before.visitStatus).toBe("intake_done");
  expect(before.status.hasDexcom).toBe(false);
  expect(before.sourJob, "the wrap had no readings to summarize").toBeNull();
  expect(before.providerSummary).toBeNull();
  expect(summaryMail(email), "and nobody has been told a summary is ready").toBeNull();

  // The export arrives. This is the import §7.1 asks about, through the route a Clarity upload takes.
  const shared = await request.post("/api/upload", {
    multipart: { token, kind: "dexcom", file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(shared.status(), await shared.text()).toBe(200);
  expect((await shared.json()).count).toBeGreaterThan(0);

  // A job, queued by the import: read through the clinician's bundle, which is where §7.2 keeps it
  // (lib/bundle.ts, latestJobForVisit). Polled because the row is written while the upload's response is
  // on its way back, and the inline runner may already have taken it — queued, running or done all say the
  // import queued one, and "no job at all" is the bug.
  await expect
    .poll(async () => (await (await page.request.get(`/api/patient/${visitId}`)).json()).sourJob?.status ?? "none", { timeout: 30_000 })
    .toMatch(/^(queued|running|done)$/);

  // §2.6: the run finishes and tells them, with nobody having opened the brief. The patient's own address
  // is the one the mailbox can be searched by — a message to the clinician goes to the seeded demo address
  // every other spec signs in as — and it is the same `notify.summary` job that writes both halves.
  await expect.poll(() => summaryMail(email), { timeout: 60_000 }).toMatch(/Your summary is ready/);
  const after = await (await page.request.get(`/api/patient/${visitId}`)).json();
  expect(after.providerSummary, "the brief the clinician's link opens").toBeTruthy();
  expect(after.visitStatus).toBe("summary_ready");
  expect(after.sourJob.status).toBe("done");

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
