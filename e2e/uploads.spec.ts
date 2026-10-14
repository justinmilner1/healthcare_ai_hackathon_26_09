import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// T11 (design §3.3, §9.1): the upload gates and the storage adapter, through the real route. The file a
// patient picks is checked for size and shape before any parser sees it, the bytes go to the storage
// adapter, and the row keeps the key — so these drive the intake screen rather than calling lib/ directly.

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

const LOADED = { timeout: 30_000 };
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");
const timeline = () => readFileSync(join(process.cwd(), "data", "fixtures", "timeline_android.json"), "utf8");

// No sign-in: the patient's credential is the token in the link (§5.3), and an unattributed booking lands on
// the seeded demo provider, the same way e2e/flows.spec.ts opens its patient flow.
async function bookVisit(request: import("@playwright/test").APIRequestContext, name: string) {
  const booked = await (
    await request.post("/api/book", { data: { name, visitType: "follow_up", reason: "mornings running high", optIn: false } })
  ).json();
  expect(booked.token).toBeTruthy();
  return booked as { token: string; visitId: string };
}

test("intake uploads: a real export is stored, the wrong file is refused in plain language", async ({ page, request }) => {
  const { token } = await bookVisit(request, "E2E Uploader");
  await page.goto(`/s/${token}/intake`);
  // The intake screen opens on its welcome step; the data sources are the step after it.
  await page.getByRole("button", { name: /Let's get started/i }).click();

  const dexcomInput = page.getByLabel(/Upload Dexcom file/i);
  await expect(dexcomInput).toBeAttached(LOADED);
  await dexcomInput.setInputFiles({ name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) });
  // The card states what was stored, which only happens after the route parsed the file and the adapter
  // wrote the bytes: the response the card reads comes after both.
  await expect(page.getByText(/records securely added/i)).toBeVisible(LOADED);

  // A Takeout zip is the mistake patients actually make. It is named for what it is, not fed to a CSV parser,
  // and the Dexcom data already connected stays connected.
  const whoopInput = page.getByLabel(/Upload WHOOP file/i);
  await whoopInput.setInputFiles({ name: "Takeout.zip", mimeType: "application/zip", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]) });
  await expect(page.getByText(/unzip it and upload the file inside/i)).toBeVisible(LOADED);
  await expect(page.getByText(/records securely added/i)).toBeVisible();
  await shot(page, "patient-intake-uploads");
});

test("upload gates: oversized, wrong format, and empty files never reach a parser", async ({ request }) => {
  const { token } = await bookVisit(request, "E2E Gatekeeper");
  const post = (kind: string, name: string, buffer: Buffer, mimeType = "text/csv") =>
    request.post("/api/upload", { multipart: { token, kind, file: { name, mimeType, buffer } } });

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
