import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import { parseWhoopCsv } from "./sleep";

pinUtcTimeZone(); // the WHOOP fixtures carry device-local timestamps with no offset

test("a WHOOP cycle export becomes one night per row", () => {
  assert.deepEqual(parseWhoopCsv(fixture("whoop_cycles.csv")), [
    { date: "2026-09-19", hours: 7.3, recovery: 68 }, // 438 min
    { date: "2026-09-20", hours: 5.3, recovery: 41 }, // 318 min, the short night
    { date: "2026-09-21", hours: 7.7, recovery: 74 }, // 462 min
  ]);
});

test("the header match is loose enough for the other export's column names", () => {
  // Date / Sleep duration (min), and no recovery column at all.
  const nights = parseWhoopCsv(fixture("whoop_alt_headers.csv"));
  assert.deepEqual(nights, [
    { date: "2026-09-19", hours: 6.8, recovery: undefined },
    { date: "2026-09-21", hours: 5.5, recovery: undefined },
  ]);
  // The unparseable date and the non-numeric duration in between are dropped, not guessed at.
  assert.equal(nights.length, 2);
});

test("hours are minutes rounded to one decimal", () => {
  const csv = "Cycle start time,Asleep duration (min)\n2026-09-19 22:00:00,455\n2026-09-20 22:00:00,0\n";
  assert.deepEqual(parseWhoopCsv(csv), [
    { date: "2026-09-19", hours: 7.6, recovery: undefined }, // 7.5833 -> 7.6
    { date: "2026-09-20", hours: 0, recovery: undefined },
  ]);
});

test("a file with no usable columns yields nothing", () => {
  assert.deepEqual(parseWhoopCsv(""), []);
  assert.deepEqual(parseWhoopCsv("Cycle start time,Asleep duration (min)\n"), []); // header only
  assert.deepEqual(parseWhoopCsv("Strain,Calories\n12.4,2100\n"), []); // neither column present
  assert.deepEqual(parseWhoopCsv("Cycle start time,Recovery score %\n2026-09-19 22:00:00,70\n"), []); // no duration
});
