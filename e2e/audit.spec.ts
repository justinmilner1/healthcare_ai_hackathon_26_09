import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";

// T12 (design §4.8, §10.2): the audit trail end to end. Three of §10.2's four categories are produced here by
// doing the thing rather than by writing a row — a patient presents their link and uploads a file, a clinician
// reads the visit, the patient withdraws the upload — and then the admin page is asked what it saw. Sends are
// the fourth; no email or SMS backend is configured in this run, so nothing is sent and a row saying otherwise
// would be a lie (lib/jobHandlers.ts, recordSends).
//
// The last assertions are §4.8's promise, checked against the real table rather than against the allow-list
// that produces it: every piece of this patient's data that the app holds, looked for in the export and in the
// JSON the page reads, and found in neither.

// The whole practice's trail is on this screen and every other spec in the run adds rows to it, so the
// unfiltered shot has no fixed height. Full-page on the desktop project, where a row is a line of a table;
// the viewport on the phone, where each row stacks into five labelled lines and the same page came out
// 25,000 pixels tall — a picture that shows a reviewer nothing. The filtered shot below is full-page on
// both, because by then exactly this visit's three rows are on screen.
const shot = async (page: Page, name: string, fullPage = test.info().project.name === "desktop") => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage });
};

const LOADED = { timeout: 30_000 };

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

/** Everything about this patient that must never reach an audit row, plus the seeded patient's details: a
 *  practice has more than one patient and the export is of the whole practice. */
const PATIENT = { name: "Audit Patient", phone: "+14155550199", email: "audit.patient@example.com", reason: "mornings running high" };
const SEEDED = ["Sam Sample", "+14155550100"];

test("the audit trail records reads, link use and deletions, and exports them without PHI", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  expect(demo.role, "the seeded provider is their practice's admin, which §10.2 makes the audience for this").toBe("admin");

  const booked = await (await postJson(page.request, "/api/book", { ...PATIENT, visitType: "follow_up", optIn: false })).json();
  expect(booked.visitId).toBeTruthy();

  // The patient, on their own link and with no session: the upload resolves the token, which is §5.3's
  // verification and §10.2's first row. `request`, not `page.request`, so no provider session is in play.
  const token = await csrfToken(request);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": token },
  });
  expect(uploaded.ok(), `upload: ${uploaded.status()}`).toBeTruthy();

  // The clinician opens the visit: one row per part of the bundle that came back, which with one upload and
  // no intake yet is the uploads and nothing else (lib/auditLog.ts, visitPartsRead).
  expect((await page.request.get(`/api/patient/${booked.visitId}`)).ok()).toBeTruthy();

  // And the patient changes their mind, which is §10.2's deletion.
  const deleted = await request.delete("/api/upload", { data: { token: booked.token, kind: "dexcom" }, headers: { "x-csrf-token": token } });
  expect(deleted.ok(), `delete: ${deleted.status()}`).toBeTruthy();

  await page.goto("/provider/audit");
  await expect(page.getByRole("heading", { name: "Who touched what." })).toBeVisible(LOADED);
  const table = page.locator(".audit-table");
  await expect(table).toContainText("Uploaded data read", LOADED);
  await expect(table).toContainText("Patient link accepted");
  await expect(table).toContainText("Upload deleted");
  await expect(table).toContainText(demo.name);
  await shot(page, "provider-audit");

  // Filter by action: the one category stays, the others go.
  await page.getByLabel("Action").selectOption("patient.verified");
  await expect(table).not.toContainText("Uploaded data read", LOADED);
  await expect(table).toContainText("Patient link accepted");

  // Filter by the thing itself. The seeded visit is in this practice too, so this is a filter that has
  // something to exclude.
  await page.getByLabel("Action").selectOption("");
  await page.getByLabel("Visit or upload id").fill(booked.visitId);
  await expect(table).toContainText("Upload deleted", LOADED);
  await expect(page.locator(".audit-table tbody tr")).not.toHaveCount(0);
  // Three rows, all of them this visit's: the link accepted, the clinician's read, the deletion.
  await expect(table).toContainText("Patient link accepted");
  await expect(table).toContainText("Uploaded data read");
  await shot(page, "provider-audit-visit", true);

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
  expect(exported.split("\r\n")[0]).toBe("at,actor,actorType,actorId,action,entityType,entityId,detail");
  expect(exported).toContain("patient.verified");
  expect(exported).toContain("upload.deleted");

  // §4.8, against the table rather than the allow-list: nothing about either patient is in here.
  const listing = await (await page.request.get("/api/audit?limit=500")).json();
  expect(listing.total).toBeGreaterThan(2);
  for (const [where, haystack] of [
    ["the CSV export", exported],
    ["the JSON the page reads", JSON.stringify(listing)],
  ] as const) {
    for (const phi of [...Object.values(PATIENT), ...SEEDED, booked.token, "Clarity.csv"]) {
      expect(haystack, `${where} contains ${phi}`).not.toContain(phi);
    }
  }
});
