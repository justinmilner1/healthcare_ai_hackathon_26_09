import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo } from "./auth";
import { patientEmail, verifyByApi } from "./patient";
import { MODAL, shot } from "./shot";
import { RUNNER_PORT, RUNNER_SECRET } from "../playwright.config";

// T14 (design §2.8, §10.4, §10.5): the deletion a patient asks for, driven through the screen staff use.
//
// The patient under test is given everything §10.5 names before it is taken away — a verified link, an
// uploaded Clarity export, a transcript, and the summaries written from them — because "end to end" is only
// worth asserting on a visit that had something in it. Then the dashboard's Delete data button, the
// confirmation, and the three things that have to be true afterwards: their row is gone, their link opens
// nothing, and the practice's audit log says the deletion happened without saying anything about them.
//
// The nightly sweep (§10.4) is not driven from here. It needs visits months past a practice's window, which
// no screen can create, and it is enqueued at most once in twenty hours (lib/retentionStore.ts), so a spec
// asserting on it would be asserting on which other spec drained the queue first. Its behaviour is in
// lib/retentionStore.test.ts against a real database, visit by visit; what this file checks is the wiring
// that gets it queued at all.

const LOADED = { timeout: 30_000 };

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

/** A name nothing else in the run will use: two Playwright projects share one database. */
const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const uniquePhone = () => `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;

test("a deletion request removes everything the patient gave us, and leaves a record that it happened", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const patient = { name: uniqueName("Erase Patient"), phone: uniquePhone(), email: patientEmail("erase patient") };

  // A visit with something in it. `channel: "none"` is "do not message this patient" (§2.2): there is no
  // invite to send here, and the code below goes to whatever contact details are on file (§5.3).
  const booked = await (await postJson(page.request, "/api/book", { ...patient, visitType: "follow_up", channel: "none" })).json();
  expect(booked.visitId, `booking: ${JSON.stringify(booked)}`).toBeTruthy();

  // The patient, on their own link and with no provider session: the code from their own email turns the
  // link into a 24-hour session (§2.3), and then they upload a week of readings (§9.1).
  await verifyByApi(request, booked.token, patient.email);
  const token = await csrfToken(request);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": token },
  });
  expect(uploaded.ok(), `upload: ${uploaded.status()}`).toBeTruthy();
  // And a summary written from it, so the deletion has every kind of row to remove (§7.1).
  expect((await postJson(page.request, "/api/sour", { visitId: booked.visitId })).ok()).toBeTruthy();
  await expect
    .poll(async () => (await (await page.request.get(`/api/patient/${booked.visitId}`)).json()).providerSummary !== null, { timeout: 60_000 })
    .toBe(true);

  // §10.5's staff action, from the row it belongs to.
  await page.goto("/provider");
  const row = page.locator(".provider-table tbody tr", { hasText: patient.name });
  await expect(row).toBeVisible(LOADED);
  await row.getByRole("button", { name: "Delete data" }).click();

  const dialog = page.getByRole("dialog", { name: /Delete this patient's data/i });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(patient.name);
  // §10.5 "with confirmation": until the name matches, there is nothing to press.
  const confirm = dialog.getByRole("button", { name: /Delete permanently/i });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type the patient's name to confirm/i).fill("Someone Else");
  await expect(confirm).toBeDisabled();
  await shot(page, "provider-delete-confirm", MODAL);

  await dialog.getByLabel(/Type the patient's name to confirm/i).fill(patient.name);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The purge is a job (§3.4), so the row goes when it has run rather than when the button was pressed.
  await expect
    .poll(
      async () => {
        const data = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string }[] };
        return data.visits.some((v) => v.name === patient.name);
      },
      { timeout: 60_000 },
    )
    .toBe(false);
  await page.reload();
  await expect(page.locator(".provider-table")).not.toContainText(patient.name, LOADED);
  // The table is what this shot is about, and on a phone it is below a screen of hero and metrics, so the
  // helper scrolls the card to the top of the viewport first (e2e/shot.ts).
  await shot(page, "provider-dashboard-after-deletion", { scrollTo: ".provider-table-card" });

  // Gone for the clinician: the visit is not a visit any more, which is the same 404 as one that never was.
  expect((await page.request.get(`/api/patient/${booked.visitId}`)).status()).toBe(404);
  // And gone for the patient: their own link opens nothing, with the sentence a bad link gets.
  await page.goto(`/s/${booked.token}`);
  await expect(page.locator("body")).toContainText(/couldn't find that link/i, LOADED);

  // §2.8, §10.2: what stays is the record of the deletion, on the practice's audit page.
  await page.goto("/provider/audit");
  const table = page.locator(".audit-table");
  await expect(table).toContainText("Patient data deleted", LOADED);
  await page.getByLabel("Action").selectOption("patient.deleted");
  await expect(table).toContainText(demo.name, LOADED);
  await shot(page, "provider-audit-deletion", { scrollTo: ".provider-table-card" });

  // §4.8, against the real table: the row says how much went and nothing about whom.
  const csv = await page.request.get("/api/audit?limit=500&format=csv");
  expect(csv.ok()).toBeTruthy();
  const exported = await csv.text();
  expect(exported).toContain("patient.deleted");
  for (const phi of [patient.name, patient.phone, patient.email, booked.token, "Clarity.csv"]) {
    expect(exported, `the export contains ${phi}`).not.toContain(phi);
  }
});

test("the deletion refuses a role that may not do it, a session that is not there, and the wrong name", async ({ page, request }) => {
  // A practice of its own, so the patient being pointed at from elsewhere is really another practice's.
  const admin = await signInAs(page, freshEmail("deletion-admin"));
  const name = uniqueName("Refusal Patient");
  const booked = await (await postJson(page.request, "/api/book", { name, phone: uniquePhone(), channel: "none" })).json();
  expect(booked.patientId).toBeTruthy();
  expect(admin.role).toBe("admin");

  // §10.5 "with confirmation", on the server and not only in the dialog: a payload without the name is
  // refused, whatever the client did or did not show.
  for (const confirm of [undefined, "", "yes", "DELETE", name.slice(0, 4)]) {
    const refused = await postJson(page.request, "/api/deletion", { patientId: booked.patientId, confirm });
    expect(refused.status(), `confirm=${JSON.stringify(confirm)}`).toBe(400);
    expect((await refused.json()).code).toBe("deletion_not_confirmed");
  }

  // §5.2: a clinician reads summaries and does not delete the record behind them.
  const clinicianEmail = freshEmail("deletion-clinician");
  expect((await postJson(page.request, "/api/practice/users", { email: clinicianEmail, role: "clinician", name: "Dr Keep" })).ok()).toBeTruthy();
  await page.context().clearCookies();
  await signInAs(page, clinicianEmail);
  expect((await postJson(page.request, "/api/deletion", { patientId: booked.patientId, confirm: name })).status()).toBe(403);
  // The button is not on their screen either, which is a courtesy and not the lock (lib/guard.ts).
  await page.goto("/provider");
  await expect(page.locator(".provider-table tbody tr", { hasText: name })).toBeVisible(LOADED);
  await expect(page.locator(".provider-delete-button")).toHaveCount(0);

  // §5.2 again: another practice's patient id is the same 404 as one that never existed, because a 403 here
  // would confirm that this clinic has a patient with that id.
  await page.context().clearCookies();
  await signInAsDemo(page);
  expect((await postJson(page.request, "/api/deletion", { patientId: booked.patientId, confirm: name })).status()).toBe(404);
  expect((await postJson(page.request, "/api/deletion", { patientId: "c0nosuchpatientidhere", confirm: name })).status()).toBe(404);

  // And with no session at all it is a 401, like every other provider route.
  expect((await postJson(request, "/api/deletion", { patientId: booked.patientId, confirm: name })).status()).toBe(401);
});

test("the job runner asks for the nightly sweep, and asks for it once", async ({ request }) => {
  // §10.4 wants the sweep nightly and §3.4 gives the app one clock: the runner's own tick. The runner port is
  // the only server with a JOBS_SECRET, so it is the only one that answers this route at all
  // (playwright.config.ts). Whether *this* call is the one that queued today's sweep depends on which spec
  // reached the route first, so what is asserted is the part that holds either way: the runner reports on the
  // sweep, and having reported one queued it does not queue another.
  const runner = `http://localhost:${RUNNER_PORT}/api/jobs/run`;
  const headers = { Authorization: `Bearer ${RUNNER_SECRET}` };

  const first = await request.post(runner, { headers });
  expect(first.ok(), `POST /api/jobs/run: ${first.status()}`).toBeTruthy();
  const report = await first.json();
  expect(typeof report.sweepQueued, JSON.stringify(report)).toBe("boolean");

  const second = await (await request.post(runner, { headers })).json();
  expect(second.sweepQueued, "one sweep per window, however often the scheduler ticks").toBe(false);
});
