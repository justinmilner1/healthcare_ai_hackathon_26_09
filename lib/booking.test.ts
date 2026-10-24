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
import { DEMO_ONLY_TEST_ADDRESSES } from "./demo";
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

/** A number and an address step 1 collected. Both channels have one, so a case about the channel is not
 *  quietly also a case about a missing contact detail. */
const SAM = { phone: "+14155550123", email: "sam@example.com" };

/** T145 A pair §13.4 refuses from a demo practice: neither is in the NANP's fictitious 555-01xx range nor
 *  under a reserved domain, so both are somebody's (lib/demo.ts). The number is the ticket's own. */
const REAL = { phone: "+16505552652", email: "prospect@example-endo.com" };

describe("bookingPlan", () => {
  it("promises the send, and names where it goes, when the deployment can make it", () => {
    const plan = bookingPlan({ channel: "both", phone: "+14155550123", email: "sam@example.com" });
    assert.equal(plan.lede, "Saving creates the patient and sends their private Sweetie link on the channel you choose here.");
    assert.equal(plan.note, "The secure link goes to +14155550123 and sam@example.com.");
    assert.equal(plan.action, "Add patient & send →");
    assert.equal(plan.blocked, false);
  });

  it("asks for a contact detail where step 1 left both blank, which is not a fault", () => {
    const plan = bookingPlan({ channel: "sms" });
    assert.equal(plan.note, "The secure link goes to — add a number or address on the first step.");
    assert.equal(plan.blocked, false, "nothing is wrong with the deployment");
  });

  it("says before the button that this deployment cannot send on the chosen channel (§8.1)", () => {
    const plan = bookingPlan({ channel: "email", fault: NO_EMAIL, email: "sam@example.com" });
    assert.equal(plan.note, `No invite will be sent: ${NO_EMAIL}. Save this patient and copy the link from the dashboard and hand it over yourself.`);
    assert.equal(plan.blocked, true);
    // The address is not repeated as a destination: "The secure link goes to …" was the claim, and the whole
    // ticket is that it is not true on this branch.
    assert.doesNotMatch(plan.note, /goes to/);
  });

  it("keeps the three lines agreeing: either all of them expect a send or none of them does", () => {
    for (const channel of ["both", "sms", "email"] as const) {
      const sendable = bookingPlan({ channel, ...SAM });
      assert.match(sendable.lede, /sends their private Sweetie link/, channel);
      assert.match(sendable.action, /& send/, channel);

      const blocked = bookingPlan({ channel, fault: cannotSendYet(channel), ...SAM });
      for (const line of [blocked.lede, blocked.note, blocked.action]) {
        assert.doesNotMatch(line, PROMISES_SEND, `${channel}: ${line}`);
        assert.doesNotMatch(line, MOTION, `${channel}: ${line}`);
      }
      assert.equal(blocked.action, "Add patient →");
    }
  });

  it("leaves \"Do not message\" the practice's own choice and not a gap in the deployment (T120)", () => {
    const chosen = bookingPlan({ channel: "none", ...SAM });
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
    assert.deepEqual(bookingPlan({ channel: "none", fault: NO_EMAIL, ...SAM }), chosen);
    // And a demo practice booking a destination §13.4 refuses still reads as the practice's own choice:
    // nothing was going to be sent, so there is no rule to explain (T145).
    assert.deepEqual(bookingPlan({ channel: "none", demo: true, phone: REAL.phone, email: REAL.email }), chosen);
  });

  it("says nothing on the step that the card would then retract (T111, T122)", () => {
    // The pair the ticket is about, in order: the forecast and the report for one booking in one office.
    // Each `bookingPlan` branch is matched with the `bookedOutcome` the press would produce, and the test is
    // that both of them are honest about the same deployment.
    for (const [fault, queued] of [
      [undefined, true],
      [NO_EMAIL, false],
    ] as const) {
      const plan = bookingPlan({ channel: "email", fault, email: SAM.email });
      const card = bookedOutcome({ name: "Sam Taylor", channel: "email", queued, reason: fault });
      assert.equal(PROMISES_SEND.test(`${plan.lede} ${plan.note} ${plan.action}`), queued, `forecast, queued=${queued}`);
      assert.equal(MOTION.test(`${card.heading} ${card.lede}`), queued, `card, queued=${queued}`);
    }

    // T145 And the pair the *ticket* is about, in an office that can send: the step and the card for one
    // demo practice booking one prospect's real number, which disagreed for a month. `reason` is what
    // `inviteReach` hands POST /api/book, so the two lines are quoting one sentence.
    const demo = bookingPlan({ channel: "sms", demo: true, ...REAL });
    const demoCard = bookedOutcome({ name: "Sam Taylor", channel: "sms", queued: false, reason: DEMO_ONLY_TEST_ADDRESSES });
    assert.doesNotMatch(`${demo.lede} ${demo.note} ${demo.action}`, PROMISES_SEND);
    assert.doesNotMatch(`${demoCard.heading} ${demoCard.lede}`, MOTION);
    assert.equal(demoCard.lede, `Patient added. No invite sent: ${DEMO_ONLY_TEST_ADDRESSES}. Share the link below.`);
  });

  it("says before the button that a demo practice will not write to this destination (§13.4, T145)", () => {
    // The ticket's own screen: a demo practice, a prospect's real mobile number, and an office that can
    // text. No fault is passed, because there is nothing wrong with the deployment — which is exactly how
    // this branch used to be missed.
    for (const channel of ["both", "sms", "email"] as const) {
      const plan = bookingPlan({ channel, demo: true, ...REAL });
      assert.equal(
        plan.note,
        `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Save this patient and copy the link from the dashboard and hand it over yourself.`,
        channel,
      );
      assert.equal(plan.blocked, true, channel);
      assert.equal(plan.action, "Add patient →", channel);
      assert.doesNotMatch(plan.lede, PROMISES_SEND, channel);
      // Not the deployment's sentence: nobody has anything to configure, and sending staff to whoever set
      // Sweet Spot up over a rule is the next ticket in this family.
      assert.doesNotMatch(plan.note, /cannot send|ask whoever/, channel);
      // And the destination is not repeated as one, like the fault branch above.
      assert.doesNotMatch(plan.note, /goes to/, channel);
    }
  });

  it("leaves a demo practice booking a reserved destination exactly as it was (§13.4)", () => {
    // The walkable demo: the fictitious number and the `.local` address §13.4 allows. This is the screen a
    // salesperson is on most of the time, so nothing about it may change.
    const reserved = { phone: "+14155550100", email: "sam.sample@sweetspot.local" };
    const plan = bookingPlan({ channel: "both", demo: true, ...reserved });
    assert.equal(plan.note, `The secure link goes to ${reserved.phone} and ${reserved.email}.`);
    assert.equal(plan.blocked, false);
    assert.equal(plan.action, "Add patient & send →");
    // And a practice that is not a demo one is untouched by the rule, whatever it books — nearly every one.
    assert.deepEqual(bookingPlan({ channel: "both", ...REAL }), bookingPlan({ channel: "both", ...REAL, demo: false }));
    assert.equal(bookingPlan({ channel: "both", ...REAL }).note, `The secure link goes to ${REAL.phone} and ${REAL.email}.`);
  });

  it("names only the destination the invite can still reach (§13.4, T145)", () => {
    // One of the two refused is a narrower invite and not a refused one, the way one configured backend of
    // two is (T111). The step used to name both destinations off the form, so it promised a text to a
    // number §13.4 was about to refuse.
    const mixed = { phone: REAL.phone, email: "sam.sample@sweetspot.local" };
    const plan = bookingPlan({ channel: "both", demo: true, ...mixed });
    assert.equal(plan.note, `The secure link goes to ${mixed.email}.`);
    assert.equal(plan.blocked, false, "something is still going out");
    assert.doesNotMatch(plan.note, /6505552652/, "the refused number is not named as a destination");
  });

  it("asks §13.4 before the deployment's own gap, as the press does (T145)", () => {
    // `inviteReach` (lib/notify.ts) answers the press in this order, so the forecast has to: the rule is
    // the fact no amount of configuration reopens, and the one staff can act on by booking elsewhere.
    const plan = bookingPlan({ channel: "email", fault: NO_EMAIL, demo: true, ...REAL });
    assert.match(plan.note, new RegExp(DEMO_ONLY_TEST_ADDRESSES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(plan.note, /cannot send email yet/);
    assert.equal(plan.blocked, true);
  });

  it("keeps every sentence in staff's words (§3.7, §10.6)", () => {
    for (const channel of ["both", "sms", "email", "none"] as const) {
      for (const fault of [undefined, cannotSendYet(channel)]) {
        // T145 Every demo arm as well, where the sentence is quoted from lib/demo.ts rather than
        // lib/delivery.ts: a rule staff cannot act on is as much a leak as a variable name.
        for (const demo of [false, true]) {
          for (const to of [SAM, REAL]) {
            const plan = bookingPlan({ channel, fault, demo, ...to });
            for (const line of [plan.lede, plan.note, plan.action]) {
              assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
            }
          }
        }
      }
    }
  });
});
