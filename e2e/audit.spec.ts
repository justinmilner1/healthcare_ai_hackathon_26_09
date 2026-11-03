import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  auditLede,
  auditSpanClause,
  auditSpanSeconds,
  auditStampsOrdered,
  auditSpanWords,
  AUDIT_COLUMNS,
  READ_COALESCE_MS,
} from "../lib/auditLog";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyByApi } from "./patient";
import { shot } from "./shot";

// T12 (design §4.8, §10.2): the audit trail end to end. All four of §10.2's categories are produced here by
// doing the thing rather than by writing a row — a patient verifies their link with the six-digit code (T08)
// and uploads a file, a clinician reads the visit, the patient withdraws the upload — and then the admin page
// is asked what it saw. The send is the code itself: with no email backend configured it goes to the local
// mailbox (lib/mailer.ts), which is a real send to a real place and is recorded as `code.sent` with that
// backend's name. A channel no backend even tried stays unrecorded, because a row saying otherwise would be
// a lie (lib/jobHandlers.ts, recordSends).
//
// The last assertions are §4.8's promise, checked against the real table rather than against the allow-list
// that produces it: every piece of this patient's data that the app holds, looked for in the export and in the
// JSON the page reads, and found in neither.

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

/** Everything about this patient that must never reach an audit row, plus the seeded patient's details: a
 *  practice has more than one patient and the export is of the whole practice. The address is per run and
 *  per booking, because it is also where the six-digit code goes (e2e/patient.ts). */
const patientUnder = () => ({
  name: "Audit Patient",
  phone: "+14155550199",
  email: patientEmail("Audit Patient"),
  reason: "mornings running high",
});
const SEEDED = ["Sam Sample", "+14155550100"];

test("the audit trail records reads, link use and deletions, and exports them without PHI", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  expect(demo.role, "the seeded provider is their practice's admin, which §10.2 makes the audience for this").toBe("admin");

  const patient = patientUnder();
  // `channel: "none"` is "do not message this patient" (T07, §2.2): there is no invite to send here, and the
  // default would ask for a recorded consent this visit has no reason to carry. It does not touch the
  // verification code below, which goes to whatever contact details are on file (§5.3).
  const booked = await (await postJson(page.request, "/api/book", { ...patient, visitType: "follow_up", channel: "none" })).json();
  expect(booked.visitId, `booking: ${JSON.stringify(booked)}`).toBeTruthy();

  // The patient, on their own link and with no provider session: the code from their own email turns the
  // link into a 24-hour session (§2.3, §5.3), which is §10.2's verification and the first row. `request`,
  // not `page.request`, so nothing a provider holds is in play.
  await verifyByApi(request, booked.token, patient.email);
  const token = await csrfToken(request);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": token },
  });
  expect(uploaded.ok(), `upload: ${uploaded.status()}`).toBeTruthy();

  // The clinician opens the visit: one row per part of the bundle that came back, which with one upload and
  // no intake yet is the uploads and nothing else (lib/auditLog.ts, visitPartsRead).
  expect((await page.request.get(`/api/patient/${booked.visitId}`)).ok()).toBeTruthy();

  // And opens it twice more, a second apart, which is what §7.2's poll and a page left open do. All three
  // are counted on the one row (lib/auditStore.ts), so this is the coalesced row T220 is about: the
  // assertions further down are that the row says what span it covers, and the wait is what gives it one
  // longer than the clock's own resolution. A slow box only makes the span longer, and the bound the store
  // now holds is READ_COALESCE_MS either way.
  await page.waitForTimeout(1_100);
  for (let i = 0; i < 2; i++) expect((await page.request.get(`/api/patient/${booked.visitId}`)).ok()).toBeTruthy();

  // And the patient changes their mind, which is §10.2's deletion.
  const deleted = await request.delete("/api/upload", { data: { token: booked.token, kind: "dexcom" }, headers: { "x-csrf-token": token } });
  expect(deleted.ok(), `delete: ${deleted.status()}`).toBeTruthy();

  await page.goto("/provider/audit");
  await expect(page.getByRole("heading", { name: "Who touched what." })).toBeVisible(LOADED);
  const table = page.locator(".audit-table");

  // T219 (§10.2, §10.7): the sentence over the table and the table's own headers are one list in
  // lib/auditLog.ts, checked here on the screen an admin reads rather than only in the unit suite. The lede
  // used to be a literal claiming entries are never edited, above five columns it said were three — so what
  // this asserts is the pair: these headers, and the sentence built from them and from the window the store
  // coalesces by. A column added to the table on its own fails the second assertion; a sentence that stopped
  // following either input fails the first.
  await expect(page.locator(".ss-lede")).toHaveText(auditLede(READ_COALESCE_MS), LOADED);
  await expect(table.locator("thead th")).toHaveText(AUDIT_COLUMNS.map((column) => column.header));
  await expect(table).toContainText("Uploaded data read", LOADED);
  await expect(table).toContainText("Patient link accepted");
  await expect(table).toContainText("Upload deleted");
  await expect(table).toContainText(demo.name);
  // The whole practice's trail is on this screen and every other spec in the run adds rows to it, so the
  // unfiltered shot has no fixed height: e2e/shot.ts leaves the page to the desktop, where a row is a line
  // of a table, and takes one screenful on the phone, where each row stacks into five labelled lines.
  await shot(page, "provider-audit");

  // Filter by action: the one category stays, the others go.
  await page.getByLabel("Action").selectOption("patient.verified");
  await expect(table).not.toContainText("Uploaded data read", LOADED);
  await expect(table).toContainText("Patient link accepted");

  // Filter by the thing itself. The seeded visit is in this practice too and every other spec in the run
  // books more, so this is a filter with plenty to exclude — and what says the filter was applied is what is
  // *not* in the table. Three category names were not enough (T61): the whole trail contains every one of
  // them, so all three passed against the unfiltered rows that were still on the screen.
  await page.getByLabel("Action").selectOption("");
  await page.getByLabel("Visit or upload id").fill(booked.visitId);
  await expect(table).toContainText("Upload deleted", LOADED);
  // All of them this visit's: the code that was sent, the link accepted, the clinician's read, the deletion.
  await expect(table).toContainText("Patient link accepted");
  await expect(table).toContainText("Uploaded data read");
  const rows = page.locator(".audit-table tbody tr");
  await expect(rows).not.toHaveCount(0);
  // The `On` cell holds the first eight characters of the id (app/provider/audit/audit.tsx, shortId), so a
  // row of another visit's is a row with this visit's prefix nowhere in it.
  await expect(rows.filter({ hasNotText: booked.visitId.slice(0, 8) })).toHaveCount(0);
  // And the count agrees: every row that matches is on the screen, rather than the first hundred of a longer
  // list the filter never narrowed.
  const matching = await rows.count();
  await expect(page.locator(".provider-patients [aria-live]")).toHaveText(`${matching} of ${matching} shown`);

  // T220 (§10.2, §10.7): the three reads above are one row, and the row says what span it stands for rather
  // than only when it ended. Before T220 the window the store looked back over was re-dated by every read
  // it absorbed, so a row could cover a span of any length while this page called it a one-minute window —
  // which is what makes the two times on the row the thing to assert, on the screen an admin reads.
  const coalesced = rows.filter({ hasText: "Uploaded data read" });
  await expect(coalesced).toHaveCount(1, { ...LOADED });
  await expect(coalesced).toContainText("count: 3", LOADED);
  const spanCell = coalesced.locator(".audit-span");
  await expect(spanCell).toBeVisible();
  await expect(spanCell).toContainText("3 reads over");
  // The span is the row's own, not the page's arithmetic: `firstAt` is on the entry the page was given, it
  // is earlier than `at`, and the gap between them is inside the window the lede promises.
  const entries = (await (await page.request.get(`/api/audit?limit=500&entityId=${booked.visitId}`)).json()).entries as {
    action: string;
    at: string;
    firstAt: string;
  }[];
  const read = entries.find((e) => e.action === "uploads.read");
  expect(read, JSON.stringify(entries.map((e) => e.action))).toBeTruthy();
  const span = Date.parse(read!.at) - Date.parse(read!.firstAt);
  expect(span, "the coalesced row kept no record of when its first read was").toBeGreaterThan(0);
  expect(span, `the row covers ${span}ms, past the ${READ_COALESCE_MS}ms window the page calls it`).toBeLessThanOrEqual(READ_COALESCE_MS);

  // T222 (§10.2, §10.7): and the span the cell *states* agrees with the two stamps that same cell *prints*.
  // This assertion used to stop at "3 reads over", so the suite could not see the cell contradicting itself:
  // both stamps go through `toLocaleString()`, which truncates to the second, while the words used to round
  // the true gap — on this very row, a real 1.3s printed as "1 second" between stamps two seconds apart.
  // Which of the branches below the run lands in depends on how fast the three reads were, so all are held.
  const stamps = await page.evaluate(
    ([at, firstAt]) => [new Date(at).toLocaleString(), new Date(firstAt).toLocaleString()],
    [read!.at, read!.firstAt],
  );
  // The cell prints what it was given: `at` on the first line, `firstAt` after "from" on the second.
  await expect(spanCell).toContainText(`, from ${stamps[1]}`);
  await expect(coalesced.locator(".audit-when")).toContainText(stamps[0]);
  // The whole span line, not its first three words, so what sits between them is readable here at all.
  const line = (await spanCell.textContent())!.trim();
  const began = Date.parse(read!.firstAt);
  const ended = Date.parse(read!.at);
  // The two writes are seconds apart on a clock that did not move, so this row is the ordered branch and the
  // suite should say so rather than quietly reading whichever branch it landed in. The out-of-order branch —
  // a clock that stepped back mid-run, which nothing here can stage — is held in lib/auditLog.test.ts.
  expect(auditStampsOrdered(began, ended), `the run's own clock went backwards: ${read!.firstAt} to ${read!.at}`).toBe(true);
  const words = line.replace(/^3 reads over /, "").replace(/, from .*$/, "");
  expect(line, `the span line is not the shape this assertion reads: ${line}`).toBe(`3 reads over ${words}, from ${stamps[1]}`);
  const seconds = auditSpanSeconds(began, ended);
  expect(words, "the cell is wording the span itself rather than taking it from lib/auditLog.ts").toBe(auditSpanWords(began, ended));
  // The whole clause, assembled where the decision lives: the cell may not word it independently (T222 AC3).
  expect(line, "the cell's span line is not the clause lib/auditLog.ts decided on").toBe(
    auditSpanClause({ ms: ended - began, seconds, words, reads: 3 }, stamps[1]).line,
  );
  // The reader's own subtraction, done the one way that needs no locale string parsed: both stamps are a
  // function of their instant's floor to the second, so if adding the stated seconds to the first printed
  // stamp lands on the second printed stamp, the two are exactly that many seconds apart on screen.
  const shifted = await page.evaluate((at) => new Date(at).toLocaleString(), new Date(began + seconds * 1000).toISOString());
  expect(shifted, `the cell says "${words}" over ${stamps[1]} and ${stamps[0]}, which are not that far apart`).toBe(stamps[0]);
  // The two readings an admin can catch in one glance (T222 AC2).
  if (stamps[0] === stamps[1]) expect(words).toBe("under a second");
  else expect(words, `"under a second" over ${stamps[1]} and ${stamps[0]}`).not.toBe("under a second");
  // Every row, not only this one: nothing the store writes may claim a span the lede does not allow.
  for (const entry of entries) {
    expect(Date.parse(entry.at) - Date.parse(entry.firstAt), `${entry.action} covers more than the window`).toBeLessThanOrEqual(READ_COALESCE_MS);
  }
  await shot(page, "provider-audit-visit", { scrollTo: ".provider-patients" });

  // A filter that matches nothing says so, rather than looking like an empty log.
  await page.getByLabel("Visit or upload id").fill("c0nosuchvisitidatallhere");
  await expect(page.locator(".audit-empty")).toBeVisible(LOADED);
  await expect(page.locator(".audit-table tbody tr")).toHaveCount(0);

  // §10.2 "exportable": the same rows as a CSV attachment.
  const csv = await page.request.get("/api/audit?limit=500&format=csv");
  expect(csv.ok()).toBeTruthy();
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  const exported = await csv.text();
  // `firstAt` beside `at`, so the export is not a weaker record than the screen (T220 AC6).
  expect(exported.split("\r\n")[0]).toBe("at,firstAt,actor,actorType,actorId,action,entityType,entityId,detail");
  expect(exported).toContain(read!.firstAt);
  expect(exported).toContain("patient.verified");
  expect(exported).toContain("upload.deleted");
  // §10.2's "every send": the six-digit code went somewhere, so the trail says so (lib/jobHandlers.ts).
  expect(exported).toContain("code.sent");

  // §4.8, against the table rather than the allow-list: nothing about either patient is in here.
  const listing = await (await page.request.get("/api/audit?limit=500")).json();
  expect(listing.total).toBeGreaterThan(2);
  for (const [where, haystack] of [
    ["the CSV export", exported],
    ["the JSON the page reads", JSON.stringify(listing)],
  ] as const) {
    for (const phi of [...Object.values(patient), ...SEEDED, booked.token, "Clarity.csv"]) {
      expect(haystack, `${where} contains ${phi}`).not.toContain(phi);
    }
  }
});

// T61: the filter has to survive the answer to the question it replaced.
//
// The screen refetches on every filter change and keeps whatever answers last, which is not the same as
// whatever was asked last (app/provider/audit/audit.tsx). The unfiltered trail is a hundred rows and a
// filtered one is a handful, so the unfiltered read is the slower of the two and could land on top of the
// filter that replaced it. Nothing arrives after it to put the screen right, so this is not a wait that
// resolves itself: the whole practice's log stays there under a filter that excludes nearly all of it,
// which is how a screenshot of "the filtered trail" came to be 1082 x 80,149 pixels of other visits.
//
// Held back by this test rather than hoped for: the delay is the real difference between the two responses,
// made big enough to be certain about.
test("a filter is not undone by the slower answer it replaced", async ({ page }) => {
  await signInAsDemo(page);
  await page.route("**/api/audit?**", async (route) => {
    if (!route.request().url().includes("entityId=")) await new Promise((wait) => setTimeout(wait, 1_500));
    await route.continue();
  });

  await page.goto("/provider/audit");
  await expect(page.getByRole("heading", { name: "Who touched what." })).toBeVisible(LOADED);
  // There is a trail to lose: every other spec in this run has put rows in it, and so has the one above.
  await expect(page.locator(".audit-table tbody tr").first()).toBeVisible(LOADED);

  // Clear the action — a slow unfiltered read — and filter by an id in the same breath, which answers at
  // once. Both are in flight; only the second one was asked for.
  await page.getByLabel("Action").selectOption("patient.verified");
  await page.getByLabel("Action").selectOption("");
  await page.getByLabel("Visit or upload id").fill("c0nosuchvisitidatallhere");

  // Nothing is recorded against that id, so the only honest screen is the empty note. The wait is the point
  // of the test and not a workaround for one: an assertion that passed before the held-back response landed
  // would be the same assertion that let 80,000 pixels of unfiltered trail through.
  await page.waitForTimeout(3_000);
  await expect(page.locator(".audit-table tbody tr")).toHaveCount(0);
  await expect(page.locator(".audit-empty")).toBeVisible();
});
