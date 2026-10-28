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
import { cannotSendYet, NO_CONSENT_TO_MESSAGE, NO_CONTACT_ON_FILE } from "./delivery";
import { DEMO_ONLY_TEST_ADDRESSES } from "./demo";
import { fixture } from "./fixtures";
import { newLinkNote, sendLinkNote } from "./inviteNote";
import { canHandOver, codeReach, codeSenders, inviteFaultByChannel, inviteReach } from "./notify";
import { channelsFor } from "./patientSession";
import { channelLabel, parseVisitCsv, warningsFor } from "./visitIntake";

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

/** And the same for texts, which T145 needs because the two halves of a `"both"` booking can be answered
 *  differently: §13.4 closing one of them leaves the deployment to be asked about the other. */
const NO_SMS = cannotSendYet("sms");

/** Anything on step 3 that reads as an invite going out. Its own pattern rather than `MOTION` above, which
 *  is written for the card's tense: the forecast's two claims are the lede's "sends their private Sweetie
 *  link" and a button offering to send, neither of which is a message already in motion. Deliberately not
 *  applied to the "Do not message" row, whose note promises a six-digit code and not an invite. */
const PROMISES_SEND = /\bsends\b|& send/i;

/** T170 Anything on step 3 that reads as the six-digit code travelling to this patient — the claim §5.3
 *  makes false for a visit with no number and no address on file, and the one the "Do not message" row made
 *  for every visit. `lib/visitIntake.test.ts`'s `CODE_IN_MOTION` word for word, because it is one rule over
 *  the two lines of one step: the note this module writes and the warning that module writes, which the
 *  wizard renders three lines apart.
 *
 *  Deliberately not a bare /code/. The sentence a reachable patient gets names the code to explain why the
 *  handover works, and is right to; what no line may say is that the code is on its way to someone there is
 *  nowhere to send it to. */
const CODE_IN_MOTION = /sends? (?:them|you|the patient)|(?:we|it)(?:'| wi)ll (?:text|email|send)|code (?:is|will be|was) sent|code (?:is )?on (?:its|the) way/i;

/** Every pair of contact details step 1 can hand step 3, which is `lib/visitIntake.test.ts`'s
 *  `CONTACT_COMBINATIONS`: the rule below is about all four rather than about the one that warns today. */
const CONTACT_COMBINATIONS = [
  { phone: null, email: null },
  { phone: "+14155550123", email: null },
  { phone: null, email: "sam@example.com" },
  { phone: "+14155550123", email: "sam@example.com" },
] as const;

/** Every value the step's radios can put in `channel`, plus the two absences the type allows. */
const EVERY_CHANNEL = ["both", "sms", "email", "none", null, undefined] as const;

/** A number and an address step 1 collected. Both channels have one, so a case about the channel is not
 *  quietly also a case about a missing contact detail. */
const SAM = { phone: "+14155550123", email: "sam@example.com" };

/** T145 A pair §13.4 refuses from a demo practice: neither is in the NANP's fictitious 555-01xx range nor
 *  under a reserved domain, so both are somebody's (lib/demo.ts). The number is the ticket's own. */
const REAL = { phone: "+16505552652", email: "prospect@example-endo.com" };

/** Set these for one call and put the environment back, whichever way the assertion goes — `undefined`
 *  unsets, because a row that means "no SMS backend" has to hold whatever the shell arrived with. The same
 *  helper lib/notify.test.ts uses, for the one test here that pairs this module with that one. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("bookingPlan", () => {
  it("promises the send, and names where it goes, when the deployment can make it", () => {
    const plan = bookingPlan({ channel: "both", phone: "+14155550123", email: "sam@example.com" });
    assert.equal(plan.lede, "Saving creates the patient and sends their private Sweetie link on the channel you choose here.");
    assert.equal(plan.note, "The secure link goes to +14155550123 and sam@example.com.");
    assert.equal(plan.action, "Add patient & send →");
    assert.equal(plan.blocked, false);
  });

  // T173 This test used to assert the sentence with the hole in it — "The secure link goes to — add a number
  // or address on the first step." — and that it sat under the sending lede and **Add patient & send →**,
  // three lines above a warning saying the link will not open. The step opens on "Text and email", so that
  // was the first thing a front desk saw for the patient §2.2 has neither detail for.
  it("stops promising a send where step 1 left both fields blank (T173)", () => {
    for (const channel of ["both", "sms", "email"] as const) {
      const plan = bookingPlan({ channel });
      // The "Do not message" row's answer word for word, because it is the same fact about the same patient:
      // nothing is sent, and the handover §8.1 falls back on is not a way in without a code (lib/delivery.ts).
      assert.equal(plan.note, "Nothing is sent, and handing the link over will not get this patient in either.", channel);
      assert.doesNotMatch(plan.note, /goes to/, channel);
      assert.equal(plan.action, "Add patient →", channel);
      assert.doesNotMatch(plan.lede, /sends their private Sweetie link/, channel);
      assert.equal(plan.blocked, false, "nothing is wrong with the deployment");
    }
    // Blank strings are the wizard's own empty fields rather than nulls, the way the "none" row reads them.
    assert.equal(bookingPlan({ channel: "both", phone: " ", email: "" }).note, bookingPlan({ channel: "both" }).note);
    // And one detail on file is the sending branch again, naming the destination it really has: the rule is
    // about a patient with nothing, not about a patient with half of it.
    assert.equal(bookingPlan({ channel: "both", phone: SAM.phone }).note, `The secure link goes to ${SAM.phone}.`);
    assert.equal(bookingPlan({ channel: "both", email: SAM.email }).note, `The secure link goes to ${SAM.email}.`);
  });

  it("asks §2.2's gap before §13.4's rule and before the deployment's own (T173)", () => {
    // The order `inviteReach` answers the press in (lib/notify.ts), which is what keeps the step and the
    // card quoting one sentence. A channel with nowhere to send to is not a channel a demo practice refused
    // or an unconfigured office could not serve, and the front desk's own two fields are what to say.
    const nothing = bookingPlan({ channel: "both" });
    assert.deepEqual(bookingPlan({ channel: "both", demo: true }), nothing);
    assert.deepEqual(bookingPlan({ channel: "both", faults: { both: NO_SMS, sms: NO_SMS, email: NO_EMAIL } }), nothing);
    assert.doesNotMatch(nothing.note, /demo practice|cannot send|whoever set/i);
  });

  it("says before the button that this deployment cannot send on the chosen channel (§8.1)", () => {
    const plan = bookingPlan({ channel: "email", faults: { email: NO_EMAIL }, email: "sam@example.com" });
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

      const blocked = bookingPlan({ channel, faults: { [channel]: cannotSendYet(channel) }, ...SAM });
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
    assert.deepEqual(bookingPlan({ channel: "none", faults: { email: NO_EMAIL }, ...SAM }), chosen);
    // And a demo practice booking a destination §13.4 refuses still reads as the practice's own choice:
    // nothing was going to be sent, so there is no rule to explain (T145).
    const refusedDestinations = bookingPlan({ channel: "none", demo: true, phone: REAL.phone, email: REAL.email });
    assert.equal(refusedDestinations.lede, chosen.lede);
    assert.equal(refusedDestinations.blocked, false, "still nobody's to fix");
    assert.equal(refusedDestinations.action, chosen.action);
    // T175 What does differ is the last clause, and it is this row's own promise rather than §13.4's rule:
    // the code goes to the same destinations the invite would have, so a practice that may write to neither
    // cannot send one either and "opening it still sends them a code" is not true of this patient.
    assert.equal(refusedDestinations.note, "Nothing is sent, and handing the link over will not get this patient in either.");
  });

  // T170 (§2.2, §2.3, §5.3, §8.1) The half of that row it had never asked about. The sentence asserted above
  // promises the code *and* names the handover it explains, and both are true only of a patient there is
  // somewhere to send a code to — but the branch returns before `phone` and `email` are looked at, although
  // it has had both since T140. So the patient §2.2 has neither for read it directly above T168's correction
  // of the very same claim.
  it("stops promising the code where there is nowhere to send one (T170)", () => {
    const nowhere = bookingPlan({ channel: "none", phone: null, email: null });
    assert.equal(nowhere.note, "Nothing is sent, and handing the link over will not get this patient in either.");
    // Still the practice's own choice and still creatable: §2.2 books this visit, so nothing here is marked
    // as something to fix and the action is the one the reachable arm gets.
    assert.equal(nowhere.blocked, false, "a missing number is not a gap in the deployment");
    assert.equal(nowhere.action, "Add patient →");
    assert.equal(nowhere.lede, bookingPlan({ channel: "none", ...SAM }).lede, "the lede is the row's, either way");
    // Blank strings are the wizard's own empty fields, not nulls (`form.phone.trim() || null` is what the
    // dashboard passes, and a CSV cell arrives the same way).
    assert.equal(bookingPlan({ channel: "none", phone: "  ", email: "" }).note, nowhere.note);

    // And criterion 1's other half: either one of them on file is enough, and that sentence is unchanged.
    for (const to of [{ phone: SAM.phone, email: null }, { phone: null, email: SAM.email }, SAM]) {
      assert.equal(
        bookingPlan({ channel: "none", ...to }).note,
        "Nothing is sent. Copy the link from the dashboard and hand it over yourself; opening it still sends them a code.",
        JSON.stringify(to),
      );
    }
  });

  it("claims no code reaches a patient there is nowhere to send one to (T170)", () => {
    // The rule rather than the wording, the way lib/visitIntake.test.ts states it for `warningsFor` and
    // lib/teamInvite.ts for `claimsEmail`: over every line this module can hand step 3, on every branch it
    // has, for the one draft §5.3 makes the claim false for. The next rewording is held to it without
    // anyone remembering this ticket.
    for (const channel of EVERY_CHANNEL) {
      for (const demo of [false, true]) {
        for (const faults of [{}, { both: NO_SMS, sms: NO_SMS, email: NO_EMAIL }]) {
          const plan = bookingPlan({ channel, faults, demo, phone: null, email: null });
          for (const line of [plan.lede, plan.note, plan.action]) {
            assert.doesNotMatch(line, CODE_IN_MOTION, `${channel}, demo=${demo}, faults=${Object.keys(faults).length}: ${line}`);
          }
        }
      }
    }
  });

  it("never puts a code in motion beside the warning that there is nowhere to send one (T170)", () => {
    // Criterion 4, which is about the screen and not about either module: the wizard renders this note and
    // `warningsFor`'s warning three lines apart (app/provider/dashboard.tsx), so where the warning is on the
    // step, nothing in the three lines above it may say the code is going anywhere. Where it is not — a
    // patient with a number or an address — the sentence that promises the code is the right one and this
    // rule says nothing about it.
    for (const to of CONTACT_COMBINATIONS) {
      for (const channel of EVERY_CHANNEL) {
        const plan = bookingPlan({ channel, ...to });
        const warnings = warningsFor(to);
        assert.equal(warnings.length, to.phone || to.email ? 0 : 1, JSON.stringify(to));
        if (!warnings.length) continue;
        const step = [plan.lede, plan.note, plan.action, ...warnings].join(" ");
        assert.doesNotMatch(step, CODE_IN_MOTION, `${channel} with nothing on file: ${step}`);
        // And the step still says the one thing it owes them, from the module that owns it — once, which is
        // why this note does not end on those words too.
        assert.match(step, /the link will not open/);
        assert.equal(plan.note.includes("the link will not open"), false, "the warning owns that clause");
      }
    }
  });

  it("says nothing on the step that the card would then retract (T111, T122)", () => {
    // The pair the ticket is about, in order: the forecast and the report for one booking in one office.
    // Each `bookingPlan` branch is matched with the `bookedOutcome` the press would produce, and the test is
    // that both of them are honest about the same deployment.
    for (const [fault, queued] of [
      [undefined, true],
      [NO_EMAIL, false],
    ] as const) {
      const plan = bookingPlan({ channel: "email", faults: fault ? { email: fault } : {}, email: SAM.email });
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
      // T175 The clause this ends on is no longer §8.1's fallback, because §13.4 is `codeReach`'s rule too:
      // a practice that may write to neither of these destinations cannot send the six-digit code to them
      // either, so the link it would be handing over does not open (lib/notify.ts `canHandOver`). The reason
      // is untouched — what is withdrawn is the remedy.
      assert.equal(
        plan.note,
        `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Handing the link over will not get this patient in either.`,
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

    // And the deployment is asked about that half too, which is the half of the narrowing this case used to
    // prove nothing about: the destination was narrowed and the fault lookup was not, so the step asked
    // whether this office could text — it could — about a booking §13.4 had already reduced to the email it
    // cannot send. A fault on the channel the rule left open is therefore the step's to say (T145).
    const emailLess = bookingPlan({ channel: "both", demo: true, faults: { email: NO_EMAIL }, ...mixed });
    assert.equal(
      emailLess.note,
      `No invite will be sent: ${NO_EMAIL}. Save this patient and copy the link from the dashboard and hand it over yourself.`,
    );
    assert.equal(emailLess.blocked, true);
    assert.equal(emailLess.action, "Add patient →");
    // While a fault on the channel §13.4 *closed* changes nothing: nothing was going to go out that way, so
    // there is no gap in the deployment to report. This is the asymmetry the single-entry parameter could
    // not express, because `channelFaults["both"]` is one answer about two channels.
    assert.deepEqual(
      bookingPlan({ channel: "both", demo: true, faults: { sms: NO_SMS }, ...mixed }),
      bookingPlan({ channel: "both", demo: true, ...mixed }),
    );
  });

  it("asks §13.4 before the deployment's own gap, as the press does (T145)", () => {
    // `inviteReach` (lib/notify.ts) answers the press in this order, so the forecast has to: the rule is
    // the fact no amount of configuration reopens, and the one staff can act on by booking elsewhere.
    const plan = bookingPlan({ channel: "email", faults: { email: NO_EMAIL }, demo: true, ...REAL });
    assert.match(plan.note, new RegExp(DEMO_ONLY_TEST_ADDRESSES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(plan.note, /cannot send email yet/);
    assert.equal(plan.blocked, true);
  });

  it("asks the deployment the same question the press does, channel for channel (§13.4, T111, T145)", () => {
    // The property criterion 3 is about, over the intersection that broke it: a deployment that can serve a
    // channel §13.4 **blocks** but not the one it **leaves open**. There `inviteSendability` has no answer
    // for the channel staff picked — the office can text, and "both" is satisfied by that — so a step that
    // asked about `"both"` promised a send, and `inviteReach`, which asks about what is left, refused it one
    // press later. The forecast and the report naming different facts about the same press is the whole bug.
    //
    // `inviteFaultByChannel()` is the real map the server hands the wizard, so this pairs the two functions
    // the product pairs rather than a hand-written stand-in.
    const RESERVED = { phone: "+14155550100", email: "sam.sample@sweetspot.local" };
    const SMS_ONLY = { SNS_ORIGINATION_NUMBER: "+14155550199", EMAIL_FROM: undefined };
    const EMAIL_ONLY = { SNS_ORIGINATION_NUMBER: undefined, EMAIL_FROM: "clinic@sweetspot.example" };
    const NEITHER = { SNS_ORIGINATION_NUMBER: undefined, EMAIL_FROM: undefined };
    const BOTH = { SNS_ORIGINATION_NUMBER: "+14155550199", EMAIL_FROM: "clinic@sweetspot.example" };

    const rows = [
      // The two the reviewer of T145 reproduced on `main`: the blocked half is the one with a backend.
      { what: "sms-only office, real phone and reserved address", env: SMS_ONLY, demo: true, to: { phone: REAL.phone, email: RESERVED.email }, sends: false },
      { what: "email-only office, reserved phone and real address", env: EMAIL_ONLY, demo: true, to: { phone: RESERVED.phone, email: REAL.email }, sends: false },
      // And the controls that already agreed and must keep agreeing (criteria 4 and 5).
      { what: "no backends at all, which is the gate's own configuration", env: NEITHER, demo: true, to: RESERVED, sends: false },
      { what: "a practice that is not a demo one", env: BOTH, demo: false, to: REAL, sends: true },
      { what: "a demo practice on reserved destinations", env: BOTH, demo: true, to: RESERVED, sends: true },
      // The narrowing itself, where one half is refused and the other really does carry the invite.
      { what: "sms-only office, real address and reserved phone", env: SMS_ONLY, demo: true, to: { phone: RESERVED.phone, email: REAL.email }, sends: true },
    ] as const;

    for (const { what, env, demo, to, sends } of rows) {
      withEnv(env, () => {
        const plan = bookingPlan({ channel: "both", faults: inviteFaultByChannel(), demo, ...to });
        const reach = inviteReach({ channel: "both", demo, ...to });
        const pressSends = reach.channels.length > 0;
        assert.equal(pressSends, sends, `${what}: the press`);
        // The forecast is the same answer in the other tense: a step promising a send where the press
        // refuses one is the disagreement, whichever direction it points.
        assert.equal(PROMISES_SEND.test(`${plan.lede} ${plan.note} ${plan.action}`), pressSends, `${what}: the forecast`);
        assert.equal(plan.blocked, !pressSends, `${what}: whether the step marks a gap`);
        // And when neither sends, both name the same *kind* of gap, so staff are not told the rule before
        // the button and the deployment after it. Not byte-identical, and deliberately: `inviteReach` words
        // its sentence for the channel staff chose (`cannotSendYet(p.channel)`), which criterion 5 freezes,
        // while the step names the half §13.4 left open — "cannot send email yet" where the route says
        // "cannot send this message yet". The step is the narrower of the two true sentences; what matters
        // here is that neither of them is the other's rule.
        if (!pressSends) {
          assert.match(plan.note, /cannot send/, `${what}: the step names the deployment's gap`);
          assert.match(reach.reason!, /cannot send/, `${what}: and so does the press`);
          assert.doesNotMatch(plan.note, /only messages reserved test addresses/, `${what}: §13.4 is not the fact here`);
        }
      });
    }
  });

  it("keeps every sentence in staff's words (§3.7, §10.6)", () => {
    for (const channel of ["both", "sms", "email", "none"] as const) {
      for (const fault of [undefined, cannotSendYet(channel)]) {
        // T145 Every demo arm as well, where the sentence is quoted from lib/demo.ts rather than
        // lib/delivery.ts: a rule staff cannot act on is as much a leak as a variable name.
        for (const demo of [false, true]) {
          for (const to of [SAM, REAL]) {
            const plan = bookingPlan({ channel, faults: fault ? { both: fault, sms: fault, email: fault } : {}, demo, ...to });
            for (const line of [plan.lede, plan.note, plan.action]) {
              assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T173 (§2.2, §2.3, §3.7, §5.3, §8.1, §10.6) The rule the nine tickets in this family each stopped one
// branch short of, over all four of them at once and — the half that matters — over a deployment that can
// send as well as one that cannot.
//
// The gate configures no sender (§11.3), and with none `inviteReach` empties `channels` for *every* visit,
// so every surface takes its "cannot send" branch and every assertion in the suite passes. That is how a
// patient with neither a phone nor an email came to be told their invite was on its way on the only kind of
// deployment this product is being piloted on. `withEnv(SENDING, …)` is the arm that can see it, and it is
// the reason this block exists rather than another row in the loops above.

/** An office with a sender behind both channels, which is what the pilot is and what the gate is not. Each
 *  backend is selected by the setting it cannot send without — EMAIL_FROM for SES (T110), an origination
 *  number for SNS (T94) — so these two are the whole of "configured". Neither value is a credential. */
const SENDING = { EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199" };

/** And the gate's own configuration, named so the two arms read as the pair they are. */
const UNCONFIGURED = { EMAIL_FROM: undefined, SNS_ORIGINATION_NUMBER: undefined };

/** §8.1's handover, which is a remedy only where the link opens — and the link opens on a code that has
 *  somewhere to go (§2.3, §5.3). Every way the four surfaces offer it, so none of them may offer it to the
 *  patient with nothing on file. `will not get this patient in` is the withdrawal and is allowed to contain
 *  "the link over", so the handover is matched by the words that *offer* it. */
const OFFERS_HANDOVER = /Share the link below|Use Copy intake|Copy the link from the dashboard|copy the link from the dashboard/;

describe("nothing claims an invite or a code is in motion to a patient with nothing on file (T173)", () => {
  for (const [arm, env] of [["a deployment that can send", SENDING], ["one that cannot", UNCONFIGURED]] as const) {
    it(`holds over ${arm}`, () => {
      withEnv(env, () => {
        for (const to of CONTACT_COMBINATIONS) {
          const nothingOnFile = !(to.phone || to.email);
          for (const channel of EVERY_CHANNEL) {
            for (const demo of [false, true]) {
              const where = `${arm}, channel=${channel}, demo=${demo}, to=${JSON.stringify(to)}`;
              // The press, asked exactly as the two routes ask it, and the handover fact they answer with.
              const reach = inviteReach({ channel, demo, ...to });
              // `channelsFor` and not a re-reading of the two fields, because that is what both routes
              // answer `handover` with (app/api/book/route.ts, app/api/invite/route.ts).
              const handover = channelsFor(to).length > 0;
              if (nothingOnFile) {
                assert.deepEqual(reach.channels, [], `${where}: the press sends nothing`);
                assert.equal(handover, false, where);
              }

              // All four surfaces, from that one answer: step 3's three lines, the success card's two, and
              // the two notes the dashboard row writes.
              const plan = bookingPlan({ channel, faults: inviteFaultByChannel(), demo, ...to });
              const card = bookedOutcome({
                name: "Sam Nobody",
                queued: reach.channels.length > 0,
                channel: reach.channels.length ? reach.channels.join(",") : channel,
                reason: reach.reason,
                handover,
              });
              const answer = { queued: reach.channels.length > 0, reason: reach.reason, handover };
              const lines = [plan.lede, plan.note, plan.action, card.heading, card.lede, sendLinkNote(answer), newLinkNote(answer)];

              if (!nothingOnFile) continue;
              for (const line of lines) {
                assert.doesNotMatch(line, MOTION, `${where}: ${line}`);
                assert.doesNotMatch(line, CODE_IN_MOTION, `${where}: ${line}`);
                assert.doesNotMatch(line, PROMISES_SEND, `${where}: ${line}`);
                // Criterion 4: and no handover either, because the link will not open to be handed over.
                assert.doesNotMatch(line, OFFERS_HANDOVER, `${where}: ${line}`);
                // Staff's words throughout: nothing about this is the deployment's (§3.7, §10.6).
                assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
              }
              // And the reason the three sending channels give is §2.2's gap rather than the deployment's or
              // §13.4's — the mix-up that sent a front desk with two empty fields after an administrator.
              if (channel && channel !== "none") {
                assert.equal(reach.reason, NO_CONTACT_ON_FILE, where);
              }
            }
          }
        }
      });
    });
  }

  it("leaves every patient with a detail on file exactly as they were", () => {
    // The other direction, which is what keeps the rule from being satisfied by saying nothing to anybody:
    // a configured office booking a reachable patient still promises the send on all four surfaces.
    withEnv(SENDING, () => {
      const reach = inviteReach({ channel: "both", ...SAM });
      assert.deepEqual(reach.channels, ["sms", "email"]);
      const plan = bookingPlan({ channel: "both", faults: inviteFaultByChannel(), ...SAM });
      assert.match(plan.lede, /sends their private Sweetie link/);
      assert.equal(plan.action, "Add patient & send →");
      const card = bookedOutcome({ name: "Sam Taylor", queued: true, channel: "both", handover: true });
      assert.match(card.heading, MOTION);
      assert.equal(sendLinkNote({ queued: true, handover: true }), "Sending now");
      // And the unsent card for a reachable patient keeps §8.1's fallback, which is a fallback for them.
      const unsent = bookedOutcome({ name: "Sam Taylor", queued: false, reason: cannotSendYet("both"), handover: true });
      assert.match(unsent.lede, OFFERS_HANDOVER);
    });
  });

  it("withdraws the card's fallback rather than its heading, because the patient was still added (§2.2)", () => {
    const added = bookedOutcome({ name: "Sam Nobody", queued: false, reason: NO_CONTACT_ON_FILE, handover: false });
    assert.equal(added.heading, "Sam Nobody is ready for Sweetie.", "§2.2 still books this visit");
    assert.equal(
      added.lede,
      `Patient added. No invite sent: ${NO_CONTACT_ON_FILE}. Handing the link over will not get this patient in either.`,
    );
    // The sentence step 3 showed three presses earlier, so the forecast and the report are one wording.
    assert.match(added.lede, /Handing the link over will not get this patient in either\.$/);
    assert.match(bookingPlan({ channel: "both" }).note, /handing the link over will not get this patient in either\.$/);
    // An answer with no `handover` field is the old one and reads as it always did: the field withdraws the
    // fallback on an explicit `false` only.
    assert.match(bookedOutcome({ name: "Sam Nobody", queued: false, reason: NO_CONTACT_ON_FILE }).lede, /Share the link below\.$/);
  });
});

// ---------------------------------------------------------------------------------------------
// T175 (§2.2, §2.3, §3.7, §5.3, §8.1, §10.6) The same rule on the other way to have nowhere to send a code:
// a deployment with no sender behind the one channel the patient does have.
//
// The block above closed the branch where the patient has no contact details, and it asked `channelsFor` —
// "has this patient a detail on file" — which is only the first of `codeReach`'s four filters. This block is
// the arm that can see the rest: **one** sender configured and not the other, so a patient whose single
// detail is the unserved channel has a field filled in and still no way to receive a code. Neither of T173's
// two arms can see it — with both senders every combination is reachable, and with neither the honest
// "cannot send yet" empties every channel for every patient, which is the trap that family of tickets keeps
// falling into.
//
// `DEV_MAIL_DIR` is cleared in both arms, and that is the whole reason the bug could not be observed. The
// code's email goes through `sendOrMailbox`, so its sender test is `canSendOrMailbox` (lib/mailer.ts), which
// that variable satisfies — and `scripts/agent-check.sh` exports it for the length of the run. In the gate
// the invite is unsendable while the code is deliverable and the handover really is a way in; a deployment
// has no mailbox. The mailbox case is lib/notify.test.ts's, where it is held unchanged.

/** An office that can text and cannot email, and its mirror. Each backend is still selected by the setting
 *  it cannot send without (T94, T110), and the mailbox is cleared because a deployment has none. */
const SMS_ONLY = { EMAIL_FROM: undefined, SNS_ORIGINATION_NUMBER: "+14155550199", DEV_MAIL_DIR: undefined };
const EMAIL_ONLY = { EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: undefined, DEV_MAIL_DIR: undefined };

describe("nothing offers the handover where no code can reach the patient (T175)", () => {
  for (const [arm, env] of [["an office that can only text", SMS_ONLY], ["one that can only email", EMAIL_ONLY]] as const) {
    it(`holds over ${arm}`, () => {
      withEnv(env, () => {
        for (const to of CONTACT_COMBINATIONS) {
          for (const channel of EVERY_CHANNEL) {
            for (const demo of [false, true]) {
              const where = `${arm}, channel=${channel}, demo=${demo}, to=${JSON.stringify(to)}`;
              // The fact the two routes answer `handover` with, asked exactly as they ask it (`canHandOver`,
              // app/api/book/route.ts, app/api/invite/route.ts), against the `codeReach` it is a reduction of.
              const reach = codeReach({ channels: channelsFor(to), ...to, demo });
              const handover = canHandOver({ ...to, demo });
              assert.equal(handover, reach.channels.length > 0, `${where}: one question, one answer`);

              const invite = inviteReach({ channel, demo, ...to });
              // What the routes actually hand the three surfaces: a practice that chose to message nobody is
              // answered before `inviteReach` is asked at all, and with its own sentence (T120,
              // app/api/book/route.ts, app/api/invite/route.ts). Modelled rather than skipped, because
              // "none" is one of the rows that offers the handover.
              const reason = channel === "none" ? NO_CONSENT_TO_MESSAGE : invite.reason;
              const plan = bookingPlan({ channel, faults: inviteFaultByChannel(), codeChannels: codeSenders(), demo, ...to });
              const card = bookedOutcome({
                name: "Sam Unreachable",
                queued: invite.channels.length > 0,
                channel: invite.channels.length ? invite.channels.join(",") : channel,
                reason,
                handover,
              });
              const answer = { queued: invite.channels.length > 0, reason, handover };
              const lines = [plan.lede, plan.note, plan.action, card.heading, card.lede, sendLinkNote(answer), newLinkNote(answer)];

              for (const line of lines) {
                if (!handover) {
                  // Criterion 1, over all four surfaces: the handover is offered only where a code can reach.
                  assert.doesNotMatch(line, OFFERS_HANDOVER, `${where}: ${line}`);
                  // And no line puts the code itself in motion to that patient either.
                  assert.doesNotMatch(line, CODE_IN_MOTION, `${where}: ${line}`);
                }
                // Criterion 5, on every arm: a half-configured office is the one most likely to be told
                // about a variable, and it is the one this block is about.
                assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
              }

              // The other direction, in the same block, so the rule cannot be satisfied by saying nothing to
              // anybody: the patient a code *can* reach keeps §8.1's fallback word for word, in each of the
              // four places it is worded.
              if (handover) {
                // Whichever sentence this patient's branch produces, the clause it ends on is §8.1's
                // fallback and not the withdrawal — which is what keeps the rule from being satisfied by
                // saying nothing to anybody. The reason it states is `bookingPlan`'s own and is not compared
                // with `inviteReach`'s here: the two disagree about a channel with no destination behind it,
                // which is its own open ticket and not this one's claim.
                if (plan.note.startsWith("No invite will be sent:")) {
                  assert.match(plan.note, /Save this patient and copy the link from the dashboard and hand it over yourself\.$/, where);
                }
                if (!answer.queued) assert.match(card.lede, /Share the link below\.$/, where);
                assert.match(sendLinkNote(answer), answer.queued ? /^Sending now$/ : /Use Copy intake to give them the link\.$/, where);
                assert.match(
                  newLinkNote(answer),
                  answer.queued ? /^New link sent\./ : /Use Copy intake to give them the new link\.$/,
                  where,
                );
              }
            }
          }
        }
      });
    });
  }

  it("is the pilot's own case: one detail, on the channel this office cannot serve", () => {
    // The ticket's reproduction, in both halves. This office can email and the patient has a mobile number:
    // the invite cannot go for want of an SMS backend, and neither can the code, so the line that refuses
    // the send must not end by offering a link that will not open.
    withEnv(EMAIL_ONLY, () => {
      const phoneOnly = { phone: SAM.phone, email: null };
      assert.equal(canHandOver(phoneOnly), false, "no code can reach a number this office cannot text");
      const plan = bookingPlan({ channel: "sms", faults: inviteFaultByChannel(), codeChannels: codeSenders(), ...phoneOnly });
      assert.equal(
        plan.note,
        `No invite will be sent: ${cannotSendYet("sms")}. Handing the link over will not get this patient in either.`,
      );
      // The deployment's own gap is still named and still marked as something somebody can fix: criterion 5
      // withdraws the remedy, not the reason (§3.7, §10.6).
      assert.equal(plan.blocked, true);
      assert.equal(plan.action, "Add patient →");
      // And the three surfaces after the press say the same thing in their own tense.
      const answer = { queued: false, reason: cannotSendYet("sms"), handover: false };
      assert.match(bookedOutcome({ name: "Sam Unreachable", ...answer }).lede, /Handing the link over will not get this patient in either\.$/);
      assert.match(sendLinkNote(answer), /Handing the link over will not get this patient in either\.$/);
      assert.match(newLinkNote(answer), /Handing the link over will not get this patient in either\.$/);
    });
    // The mirror, which is the half the e2e suite photographs: an office that can text and a patient with
    // only an address needs no new configuration to reach, because the gate has no SMS sender either.
    withEnv(SMS_ONLY, () => {
      const emailOnly = { phone: null, email: SAM.email };
      assert.equal(canHandOver(emailOnly), false);
      assert.match(
        bookingPlan({ channel: "email", faults: inviteFaultByChannel(), codeChannels: codeSenders(), ...emailOnly }).note,
        /Handing the link over will not get this patient in either\.$/,
      );
    });
  });

  it("§13.4 closes the handover the same way, which is the branch above the deployment's (T145, T175)", () => {
    // A demo practice may write only to a reserved destination, and that rule is `codeReach`'s as much as
    // the invite's — so a demo practice booking a number somebody owns cannot send the code either, however
    // well the office is configured. That branch ended on the handover too.
    withEnv({ ...SMS_ONLY, EMAIL_FROM: "clinic@sweetspot.example" }, () => {
      const real = { phone: REAL.phone, email: null };
      assert.equal(canHandOver({ ...real, demo: true }), false);
      const plan = bookingPlan({ channel: "sms", faults: inviteFaultByChannel(), codeChannels: codeSenders(), demo: true, ...real });
      assert.equal(
        plan.note,
        `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Handing the link over will not get this patient in either.`,
      );
      // Nobody is sent after a sender over a rule: this office has both (§3.7, §10.6).
      assert.doesNotMatch(plan.note, /cannot send|whoever set/);
      // And the destination §13.4 allows is untouched: the walkable demo still offers the handover.
      assert.match(
        bookingPlan({ channel: "sms", faults: inviteFaultByChannel(), codeChannels: codeSenders(), demo: true, phone: SAM.phone }).note,
        /goes to \+14155550123\.$/,
      );
    });
  });

  it("the practice's own silence stops promising a code it cannot send (T170, T175)", () => {
    // "Do not message" answers the whole question itself, and its last clause is the promise this ticket
    // makes false: "opening it still sends them a code". A number in an office that cannot text is the same
    // dead end as no number at all.
    withEnv(EMAIL_ONLY, () => {
      assert.equal(
        bookingPlan({ channel: "none", codeChannels: codeSenders(), phone: SAM.phone, email: null }).note,
        "Nothing is sent, and handing the link over will not get this patient in either.",
      );
      // The patient a code can reach keeps the sentence word for word, so the branch is narrowed and not
      // removed — and neither arm is marked as a gap in the deployment, which is what `blocked` is for.
      const open = bookingPlan({ channel: "none", codeChannels: codeSenders(), phone: null, email: SAM.email });
      assert.equal(open.note, "Nothing is sent. Copy the link from the dashboard and hand it over yourself; opening it still sends them a code.");
      assert.equal(open.blocked, false);
    });
  });

  it("a caller with no answer about the code's senders is left exactly as it was", () => {
    // `codeChannels` is optional and absent means unnarrowed, the way `handover` is read as true when absent
    // (lib/booking.ts): the deployment's half cannot be guessed, and every caller the product has passes it
    // (app/provider/page.tsx). So the branches read as they did before this ticket.
    withEnv(EMAIL_ONLY, () => {
      const phoneOnly = { phone: SAM.phone, email: null };
      assert.match(
        bookingPlan({ channel: "sms", faults: inviteFaultByChannel(), ...phoneOnly }).note,
        /Save this patient and copy the link from the dashboard and hand it over yourself\.$/,
      );
      assert.match(bookingPlan({ channel: "none", ...phoneOnly }).note, /opening it still sends them a code\.$/);
    });
  });
});
