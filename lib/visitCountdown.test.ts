// Unit tests for the patient hero's countdown to the appointment (T162, design §2.7, §12.1).
//
// The four rows of the ticket's table are the first four cases below, and three of them were wrong before
// this module existed. The third is the one the ticket is about: at 03:42, an appointment at 17:00 the
// **same day** is 13 hours out, `Math.ceil(13h / 24h)` is 1, and the page said "is tomorrow" to a patient
// whose visit was that afternoon. The second is the same error in the other direction — a genuine
// next-morning visit is more than 24 hours out, so it read "2 days" and never "tomorrow".
//
// Everything is measured against an explicit `now`, so these cases do not move with the clock the suite
// runs on. The dates are written as local wall times (`new Date(y, m, d, h, min)`) rather than as `Z`
// instants, because a calendar difference is a question about a local day and writing it in UTC would make
// every assertion here depend on the container's zone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calendarDaysUntil, visitCountdownSentence } from "./visitCountdown";

const PROVIDER = "Dr. Amara Chen";
/** A local wall time, the clock `parseScheduledAt` resolves a booking on (lib/visitIntake.ts). */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const sentence = (now: Date, appt: Date | string | null | undefined) => visitCountdownSentence(appt, PROVIDER, now);

describe("calendarDaysUntil", () => {
  it("counts calendar days, not 24-hour spans — the four rows of the T162 table", () => {
    // Row 1: three calendar days out, read as four when the gap was divided by 86400000 and ceiled.
    assert.equal(calendarDaysUntil(at(2026, 10, 29, 9, 30), at(2026, 10, 26, 3, 42)), 3);
    // Row 2: tomorrow. More than 24 hours away, so the old arithmetic called it "2 days".
    assert.equal(calendarDaysUntil(at(2026, 10, 27, 9, 30), at(2026, 10, 26, 3, 42)), 1);
    // Row 3: the bug. Later *today* — the old arithmetic called it "tomorrow".
    assert.equal(calendarDaysUntil(at(2026, 10, 26, 17, 0), at(2026, 10, 26, 3, 42)), 0);
    // Row 4: tomorrow from later in the day, the one row the old arithmetic happened to get right.
    assert.equal(calendarDaysUntil(at(2026, 10, 27, 9, 30), at(2026, 10, 26, 10, 0)), 1);
  });

  it("does not depend on the time of day on either side", () => {
    // The whole point of a calendar difference: a visit tomorrow is 1 whether it is dawn or nearly midnight
    // now, and whether the appointment is first thing or last thing. Under the old arithmetic each of these
    // four pairs gave a different answer (2, 1, 1, 1).
    for (const now of [at(2026, 10, 26, 0, 1), at(2026, 10, 26, 23, 59)]) {
      for (const appt of [at(2026, 10, 27, 0, 5), at(2026, 10, 27, 23, 55)]) {
        assert.equal(calendarDaysUntil(appt, now), 1, `${appt.toISOString()} from ${now.toISOString()}`);
      }
    }
    // And a visit at one minute past midnight tonight is today's business until midnight, not tomorrow's.
    assert.equal(calendarDaysUntil(at(2026, 10, 26, 0, 1), at(2026, 10, 26, 23, 59)), 0);
  });

  it("counts a day already past as negative, and the rest of this week forward", () => {
    assert.equal(calendarDaysUntil(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 1, 0)), -1);
    assert.equal(calendarDaysUntil(at(2026, 10, 19, 9, 30), at(2026, 10, 26, 3, 42)), -7);
    assert.equal(calendarDaysUntil(at(2026, 11, 2, 9, 30), at(2026, 10, 26, 3, 42)), 7);
  });

  it("reads an ISO instant as well as a Date, and crossing a month or a year is still a day count", () => {
    const appt = at(2026, 10, 27, 9, 30);
    assert.equal(calendarDaysUntil(appt.toISOString(), at(2026, 10, 26, 3, 42)), 1);
    assert.equal(calendarDaysUntil(at(2026, 11, 1, 9, 30), at(2026, 10, 31, 22, 0)), 1);
    assert.equal(calendarDaysUntil(at(2027, 1, 1, 9, 30), at(2026, 12, 31, 22, 0)), 1);
  });

  it("has no number for an appointment that is absent or unreadable", () => {
    assert.equal(calendarDaysUntil(null, at(2026, 10, 26, 3, 42)), null);
    assert.equal(calendarDaysUntil(undefined, at(2026, 10, 26, 3, 42)), null);
    assert.equal(calendarDaysUntil("", at(2026, 10, 26, 3, 42)), null);
    assert.equal(calendarDaysUntil("rubbish", at(2026, 10, 26, 3, 42)), null);
  });
});

describe("visitCountdownSentence", () => {
  it("says the day itself for today and tomorrow, and counts beyond that", () => {
    const now = at(2026, 10, 26, 3, 42);
    // The T162 table, as the hero prints it.
    assert.equal(sentence(now, at(2026, 10, 29, 9, 30)), `3 days until your visit with ${PROVIDER}.`);
    assert.equal(sentence(now, at(2026, 10, 27, 9, 30)), `Your visit with ${PROVIDER} is tomorrow.`);
    assert.equal(sentence(now, at(2026, 10, 26, 17, 0)), `Your visit with ${PROVIDER} is today.`);
    assert.equal(sentence(at(2026, 10, 26, 10, 0), at(2026, 10, 27, 9, 30)), `Your visit with ${PROVIDER} is tomorrow.`);
    assert.equal(sentence(now, at(2026, 11, 2, 9, 30)), `7 days until your visit with ${PROVIDER}.`);
  });

  it("never tells a patient a visit later today is tomorrow, at any hour of that day", () => {
    // The sentence this ticket exists for, asserted across the whole day rather than at one time: the old
    // arithmetic said "is tomorrow" for every hour of it where the appointment was still ahead.
    for (let hour = 0; hour < 24; hour++) {
      const line = sentence(at(2026, 10, 26, hour, 0), at(2026, 10, 26, 23, 30));
      assert.equal(line, `Your visit with ${PROVIDER} is today.`, `at ${hour}:00`);
      assert.doesNotMatch(line, /tomorrow/);
    }
  });

  it("makes no claim about when, once the day has passed", () => {
    // Nothing useful to count down to, so the sentence names the visit and stops — the wording the page
    // has always shown here. It must not say "0 days" or borrow "today".
    const line = sentence(at(2026, 10, 26, 3, 42), at(2026, 10, 25, 9, 30));
    assert.equal(line, `Your visit with ${PROVIDER}.`);
    assert.doesNotMatch(line, /today|tomorrow|day/);
  });

  it("keeps the no-appointment wording when there is no time on the visit", () => {
    // Unchanged by this ticket, and asserted so it stays that way: a visit with no `apptAt` has no day to
    // name, and this is the one branch of the four that is not about a date.
    assert.equal(sentence(at(2026, 10, 26, 3, 42), null), `Getting ready for your visit with ${PROVIDER}.`);
    assert.equal(sentence(at(2026, 10, 26, 3, 42), undefined), `Getting ready for your visit with ${PROVIDER}.`);
  });

  it("agrees its noun with the number in front of it", () => {
    // Through lib/plural.ts like every other counting noun in the product: the count branch starts at two,
    // so "1 days" is unreachable from the page, but the noun is not spelled out here either.
    const now = at(2026, 10, 26, 3, 42);
    assert.match(sentence(now, at(2026, 10, 28, 9, 30)), /^2 days until/);
    assert.match(sentence(now, at(2026, 11, 10, 9, 30)), /^15 days until/);
  });

  it("defaults `now` to the clock, so the page passes two arguments", () => {
    // The page calls it with the bundle's `apptAt` and the provider's name and nothing else.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(visitCountdownSentence(tomorrow, PROVIDER), `Your visit with ${PROVIDER} is tomorrow.`);
    assert.equal(visitCountdownSentence(new Date(), PROVIDER), `Your visit with ${PROVIDER} is today.`);
  });
});
