import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures";
import type { UploadKind } from "./types";
import { checkSize, checkUpload, contentTypeFor, formatFor, MAX_UPLOAD_BYTES, megabytes, sniffUpload } from "./uploads";

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (...values: number[]) => new Uint8Array(values);

/** Every refusal is printed inside a sentence on the patient page and read aloud, so the shape is a contract. */
function assertPlainLanguage(reason: string) {
  assert.ok(reason.length > 10 && reason.length < 200, `one short sentence, got ${reason.length} characters`);
  assert.equal(reason[0], reason[0].toLowerCase(), "starts lowercase: it is spliced into a longer sentence");
  assert.doesNotMatch(reason, /[.]$/, "no trailing period: the page adds its own");
  assert.doesNotMatch(reason, /CSV file, but|undefined|null|Error|parse/i, "says what to do, not what the parser disliked");
}

test("the cap is 20 MB, measured before the file is read", () => {
  assert.equal(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
  assert.equal(checkSize(MAX_UPLOAD_BYTES), null, "exactly at the cap is allowed");
  assert.equal(checkSize(1), null);

  const over = checkSize(MAX_UPLOAD_BYTES + 1);
  assert.ok(over && !over.ok);
  assert.match(over.reason, /20\.0 MB/);
  assertPlainLanguage(over.reason);

  const big = checkSize(34_500_000);
  assert.ok(big && !big.ok);
  assert.match(big.reason, /32\.9 MB/, "the patient is told how big their own file is");
  assert.match(big.reason, /shorter date range/, "and what to do about it");

  for (const empty of [0, -1]) {
    const result = checkSize(empty);
    assert.ok(result && !result.ok);
    assert.match(result.reason, /empty/);
  }
  assert.equal(megabytes(1024 * 1024), "1.0 MB");
});

test("a container or a binary is named for what it is, not parsed", () => {
  const cases: [string, Uint8Array, RegExp][] = [
    ["zip (Google Takeout, or a spreadsheet)", bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), /unzip/],
    ["gzip", bytes(0x1f, 0x8b, 0x08, 0x00), /uncompress/],
    ["bzip2", bytes(0x42, 0x5a, 0x68, 0x39), /uncompress/],
    ["xz", bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00), /uncompress/],
    ["pdf", utf8("%PDF-1.7\n"), /PDF/],
    ["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d), /picture/],
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), /picture/],
    ["legacy xls", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1), /spreadsheet/],
  ];
  for (const [name, head, expected] of cases) {
    const result = sniffUpload("dexcom", head);
    assert.ok(!result.ok, `${name} must be refused`);
    assert.match(result.reason, expected, name);
    assertPlainLanguage(result.reason);
  }

  // No magic bytes, but not text either: a NUL byte, or bytes that are not valid UTF-8.
  const nul = sniffUpload("dexcom", bytes(0x74, 0x00, 0x65, 0x73, 0x74));
  assert.ok(!nul.ok);
  assert.match(nul.reason, /does not look like a text file/);
  const invalid = sniffUpload("dexcom", new Uint8Array(200).fill(0xc3));
  assert.ok(!invalid.ok);
  assert.match(invalid.reason, /does not look like a text file/);
});

test("the real exports pass, each in the format its kind comes in", () => {
  const good: [UploadKind, string, "csv" | "json"][] = [
    ["dexcom", fixture("clarity_window.csv"), "csv"],
    ["whoop", fixture("whoop_cycles.csv"), "csv"],
    ["whoop", fixture("whoop_alt_headers.csv"), "csv"],
    ["visits", fixture("visits.csv"), "csv"],
    ["timeline", fixture("timeline_android.json"), "json"],
    ["timeline", fixture("timeline_ios.json"), "json"],
  ];
  for (const [kind, text, format] of good) {
    assert.deepEqual(sniffUpload(kind, utf8(text)), { ok: true, format }, `${kind} fixture`);
    assert.equal(formatFor(kind), format);
  }
  // An export saved with a byte-order mark (Excel does this) is still the same file.
  assert.deepEqual(sniffUpload("dexcom", utf8(`﻿${fixture("clarity_window.csv")}`)), { ok: true, format: "csv" });
  assert.deepEqual(sniffUpload("timeline", utf8(`\n\n  ${fixture("timeline_ios.json")}`)), { ok: true, format: "json" });
});

test("the wrong button is a wrong-file sentence, not a parse failure", () => {
  const asDexcom = sniffUpload("dexcom", utf8(fixture("timeline_android.json")));
  assert.ok(!asDexcom.ok);
  assert.match(asDexcom.reason, /JSON file.*Dexcom Clarity export is a CSV/);
  assertPlainLanguage(asDexcom.reason);

  const asTimeline = sniffUpload("timeline", utf8(fixture("clarity_window.csv")));
  assert.ok(!asTimeline.ok);
  assert.match(asTimeline.reason, /CSV.*Timeline export is a JSON file/);
  assertPlainLanguage(asTimeline.reason);

  const asWhoop = sniffUpload("whoop", utf8(fixture("timeline_ios.json")));
  assert.ok(!asWhoop.ok);
  assert.match(asWhoop.reason, /WHOOP export is a CSV/);
});

test("checkUpload runs the size gate before the type gate", () => {
  // An oversized zip is refused for its size: that is the gate that never reads the file.
  const zip = bytes(0x50, 0x4b, 0x03, 0x04);
  const oversized = checkUpload("dexcom", MAX_UPLOAD_BYTES + 1, zip);
  assert.ok(!oversized.ok);
  assert.match(oversized.reason, /most we can take/);

  const sized = checkUpload("dexcom", 4, zip);
  assert.ok(!sized.ok);
  assert.match(sized.reason, /unzip/);

  assert.deepEqual(checkUpload("dexcom", 60, utf8(fixture("clarity_window.csv"))), { ok: true, format: "csv" });
});

test("the stored object's content type follows the format", () => {
  assert.match(contentTypeFor("csv"), /^text\/csv/);
  assert.match(contentTypeFor("json"), /^application\/json/);
  assert.equal(formatFor("timeline"), "json");
  for (const kind of ["dexcom", "whoop", "visits"] as UploadKind[]) assert.equal(formatFor(kind), "csv");
});
