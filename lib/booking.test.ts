// Unit tests for what the booking wizard says about the invite — the success card after the button (T122)
// and step 3's forecast before it (T140). Design §2.2, §2.3, §8.1, §12.1.
//
// The test the ticket was filed for is `no branch claims a send that is not happening`: it runs every row of
// `data/fixtures/visit_import.csv` — nine bookings with the names, channels and empty cells a real
// scheduler's export has in it — through both branches and holds the heading to the same rule the lede has
// obeyed since T111. The heading used to be a literal, so the unsent card promised motion in its largest
// type over a sentence saying nothing had moved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookedOutcome, bookingPlan, type BookedSend } from "./booking";
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

// T140 The forecast: the same claim one press earlier, on the screen the channel is chosen on. Step 3 said
// "Saving creates the patient and sends their private Sweetie link on the channel you choose here." and
// "The secure link goes to …" over a button reading **Add patient & send →** in an office that could send
// nothing, and the card above was the first thing to mention it.
//
// `MOTION` is reused rather than restated: an unsendable forecast may no more read as motion than an unsent
// card may, and the two surfaces are one sentence apart.

/** The sentence a deployment with no email backend gets for an emailed invite, from the module that owns it
 *  rather than copied in (lib/delivery.ts, via `inviteSendability`). */
const NO_EMAIL = cannotSendYet("email");

/** Anything on step 3 that reads as an invite going out. Its own pattern rather than `MOTION` above, which
 *  is written for the card's tense: the forecast's two claims are the lede's "sends their private Sweetie
 *  link" and a button offering to send, neither of which is a message already in motion. Deliberately not
 *  applied to the "Do not message" row, whose note promises a six-digit code and not an invite. */
const PROMISES_SEND = /\bsends\b|& send/i;

describe("bookingPlan", () => {
  it("promises the send, and names where it goes, when the deployment can make it", () => {
    const plan = bookingPlan({ channel: "both", to: "+14155550123 and sam@example.com" });
    assert.equal(plan.lede, "Saving creates the patient and sends their private Sweetie link on the channel you choose here.");
    assert.equal(plan.note, "The secure link goes to +14155550123 and sam@example.com.");
    assert.equal(plan.action, "Add patient & send →");
    assert.equal(plan.blocked, false);
  });

  it("asks for a contact detail where step 1 left both blank, which is not a fault", () => {
    const plan = bookingPlan({ channel: "sms", to: "" });
    assert.equal(plan.note, "The secure link goes to — add a number or address on the first step.");
    assert.equal(plan.blocked, false, "nothing is wrong with the deployment");
  });

  it("says before the button that this deployment cannot send on the chosen channel (§8.1)", () => {
    const plan = bookingPlan({ channel: "email", fault: NO_EMAIL, to: "sam@example.com" });
    assert.equal(plan.note, `No invite will be sent: ${NO_EMAIL}. Save this patient and copy the link from the dashboard and hand it over yourself.`);
    assert.equal(plan.blocked, true);
    // The address is not repeated as a destination: "The secure link goes to …" was the claim, and the whole
    // ticket is that it is not true on this branch.
    assert.doesNotMatch(plan.note, /goes to/);
  });

  it("keeps the three lines agreeing: either all of them expect a send or none of them does", () => {
    for (const channel of ["both", "sms", "email"] as const) {
      const sendable = bookingPlan({ channel, to: "sam@example.com" });
      assert.match(sendable.lede, /sends their private Sweetie link/, channel);
      assert.match(sendable.action, /& send/, channel);

      const blocked = bookingPlan({ channel, fault: cannotSendYet(channel), to: "sam@example.com" });
      for (const line of [blocked.lede, blocked.note, blocked.action]) {
        assert.doesNotMatch(line, PROMISES_SEND, `${channel}: ${line}`);
        assert.doesNotMatch(line, MOTION, `${channel}: ${line}`);
      }
      assert.equal(blocked.action, "Add patient →");
    }
  });

  it("leaves \"Do not message\" the practice's own choice and not a gap in the deployment (T120)", () => {
    const chosen = bookingPlan({ channel: "none", to: "sam@example.com" });
    // Word for word what the step has always said on this row: T140 had to reach it on the other rows, not
    // reword it.
    assert.equal(
      chosen.note,
      "Nothing is sent. Copy the link from the dashboard and hand it over yourself; opening it still sends them a code.",
    );
    assert.equal(chosen.blocked, false, "nobody has to fix anything");
    assert.doesNotMatch(chosen.lede, /sends their private Sweetie link/);
    assert.equal(chosen.action, "Add patient →");
    // And it stays that row's sentence even where the deployment could not have sent anyway: a fault the
    // caller passes for "none" says nothing staff can act on, because nothing was going to be sent.
    assert.deepEqual(bookingPlan({ channel: "none", fault: NO_EMAIL }), chosen);
  });

  it("says nothing on the step that the card would then retract (T111, T122)", () => {
    // The pair the ticket is about, in order: the forecast and the report for one booking in one office.
    // Each `bookingPlan` branch is matched with the `bookedOutcome` the press would produce, and the test is
    // that both of them are honest about the same deployment.
    for (const [fault, queued] of [
      [undefined, true],
      [NO_EMAIL, false],
    ] as const) {
      const plan = bookingPlan({ channel: "email", fault, to: "sam@example.com" });
      const card = bookedOutcome({ name: "Sam Taylor", channel: "email", queued, reason: fault });
      assert.equal(PROMISES_SEND.test(`${plan.lede} ${plan.note} ${plan.action}`), queued, `forecast, queued=${queued}`);
      assert.equal(MOTION.test(`${card.heading} ${card.lede}`), queued, `card, queued=${queued}`);
    }
  });

  it("keeps every sentence in staff's words (§3.7, §10.6)", () => {
    for (const channel of ["both", "sms", "email", "none"] as const) {
      for (const fault of [undefined, cannotSendYet(channel)]) {
        const plan = bookingPlan({ channel, fault, to: "sam@example.com" });
        for (const line of [plan.lede, plan.note, plan.action]) {
          assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
        }
      }
    }
  });
});
