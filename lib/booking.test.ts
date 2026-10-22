// Unit tests for the booking wizard's success card (T122, design §2.2, §2.3, §8.1, §12.1).
//
// The test the ticket was filed for is `no branch claims a send that is not happening`: it runs every row of
// `data/fixtures/visit_import.csv` — nine bookings with the names, channels and empty cells a real
// scheduler's export has in it — through both branches and holds the heading to the same rule the lede has
// obeyed since T111. The heading used to be a literal, so the unsent card promised motion in its largest
// type over a sentence saying nothing had moved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookedOutcome, type BookedSend } from "./booking";
import { cannotSendYet } from "./delivery";
import { fixture } from "./fixtures";
import { channelLabel, parseVisitCsv } from "./visitIntake";

/** Anything that reads as the message being in motion. The two surfaces word it differently — "is on the
 *  way" of the patient, "is on its way" of the invite — and neither may appear on an unsent card. */
const MOTION = /on (?:the|its) way|sending|sent to|we(?:'| ha)ve (?:sent|emailed|texted)/i;

/** The bookings in the fixture that name a patient: a row with no name is refused by the preview, so it
 *  never reaches this card (lib/visitIntake.ts). */
const BOOKED = parseVisitCsv(fixture("visit_import.csv"))
  .rows.filter((row) => row.name)
  .map((row) => ({ name: row.name, channel: row.draft?.channel ?? "both" }));

describe("bookedOutcome", () => {
  it("reads the fixture's bookings, so the cases below are a scheduler's and not invented", () => {
    assert.equal(BOOKED.length, 8, "nine data rows, one of them nameless");
    assert.deepEqual(
      [...new Set(BOOKED.map((b) => b.channel))].sort(),
      ["both", "email", "sms"],
      "all three sending channels are exercised below",
    );
  });

  it("says the patient is on the way only where an invite really is", () => {
    for (const booking of BOOKED) {
      const outcome = bookedOutcome({ ...booking, queued: true });
      assert.equal(outcome.heading, `${booking.name} is on the way.`);
      assert.match(outcome.lede, /^Patient added\. The invite is on its way by /);
      assert.match(outcome.lede, new RegExp(channelLabel(booking.channel).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("no branch claims a send that is not happening", () => {
    for (const booking of BOOKED) {
      // The reason is the deployment's, in staff's words, exactly as POST /api/book hands it over.
      const outcome = bookedOutcome({ ...booking, queued: false, reason: cannotSendYet(booking.channel) });
      assert.doesNotMatch(outcome.heading, MOTION, `heading of an unsent ${booking.channel} booking`);
      assert.doesNotMatch(outcome.lede, MOTION, `lede of an unsent ${booking.channel} booking`);
      assert.equal(outcome.heading, `${booking.name} is ready for Sweetie.`);
      assert.match(outcome.lede, /No invite sent: Sweet Spot cannot send/);
      assert.match(outcome.lede, /Share the link below\.$/, "§8.1's fallback is what the card points at");
    }
  });

  it("names the patient in both headings, so the card is about a person either way", () => {
    for (const booking of BOOKED) {
      for (const queued of [true, false]) {
        assert.ok(
          bookedOutcome({ ...booking, queued }).heading.startsWith(`${booking.name} `),
          `${booking.name}, queued=${queued}`,
        );
      }
    }
  });

  it("keeps the two lines agreeing: either both say a send or neither does", () => {
    for (const booking of BOOKED) {
      for (const queued of [true, false]) {
        const { heading, lede } = bookedOutcome({ ...booking, queued, reason: queued ? undefined : cannotSendYet(booking.channel) });
        assert.equal(MOTION.test(heading), MOTION.test(lede), `${booking.name}, queued=${queued}`);
        assert.equal(MOTION.test(heading), queued);
      }
    }
  });

  it("says a visit was added to a patient already on file, on both branches", () => {
    const reused: BookedSend = { name: "Sam Taylor", channel: "email", queued: true, patientReused: true };
    assert.match(bookedOutcome(reused).lede, /^Visit added for a patient you already had\. The invite is on its way/);
    assert.match(
      bookedOutcome({ ...reused, queued: false, reason: "no consent to message this patient" }).lede,
      /^Visit added for a patient you already had\. No invite sent: no consent to message this patient\. Share the link below\.$/,
    );
  });

  it("drops the colon where the route gave no reason", () => {
    const outcome = bookedOutcome({ name: "Ada Rivera", channel: "sms", queued: false });
    assert.equal(outcome.lede, "Patient added. No invite sent. Share the link below.");
    assert.doesNotMatch(outcome.lede, MOTION);
  });

  it("names the channel that can send, not the one staff chose", () => {
    // T111's case: booked on both, and only SNS exists, so the card says text message.
    const outcome = bookedOutcome({ name: "Sam Taylor", channel: "sms", queued: true });
    assert.equal(outcome.lede, "Patient added. The invite is on its way by text message.");
  });

  it("gives the heading a subject where the name is missing or blank", () => {
    for (const name of ["", "   "]) {
      assert.equal(bookedOutcome({ name, channel: "email", queued: true }).heading, "The patient is on the way.");
      assert.equal(bookedOutcome({ name, channel: "email", queued: false }).heading, "The patient is ready for Sweetie.");
    }
  });
});
