// Unit tests for the two tenses of §2.2's import dialog's invite line (T135, design §2.2, §8.1, §12.1).
//
// The test the ticket was filed for is `the preview says it before the button, not only after it`: T111
// wrote the committed sentence and left the preview — the screen a whole day of patients is decided on —
// with nothing to say, so the correction arrived once the rows were already written. Both tenses are run
// through one rule here so the pair cannot drift apart again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet, NO_HANDOVER_SENTENCE } from "./delivery";
import { IMPORT_INTRO, importInviteNote, importIntroText, type BatchHandover } from "./importNote";
import { canHandOver, inviteFaults, type InviteBatchRow } from "./notify";

/** The reason itself always comes from lib/delivery.ts, through `inviteFaults` (lib/notify.ts). This module
 *  is only ever told it, so the tests pass what the import route really passes. */
const CANNOT = cannotSendYet("sms");

const BOTH_TENSES = [
  { what: "the preview, before anything is written", committed: false },
  { what: "the result, after the rows went in", committed: true },
];

/** T180 Every value of the third branch, so a test about the tense cannot quietly be a test about one
 *  handover answer. `"all"` is the arm every test in the first block below was written against. */
const EVERY_HANDOVER: BatchHandover[] = ["all", "some", "none"];

describe("the import dialog's line about invites that cannot go out", () => {
  it("carries the reason unchanged, in staff's words, in both tenses and on every branch", () => {
    for (const { what, committed } of BOTH_TENSES) {
      // T180 Criterion 5: "the reason keeps `cannotSendYet`'s sentence; only the remedy changes." So the
      // rule is asserted over all three handover answers rather than over the offering one.
      for (const handover of EVERY_HANDOVER) {
        const note = importInviteNote({ fault: CANNOT, committed, handover });
        assert.ok(note.includes(CANNOT), `${what}, handover=${handover} quotes the deployment's own sentence`);
        // §3.7, §10.6: this module adds words around that sentence and must not add a variable or a backend
        // to it. The same shape lib/delivery.ts's and lib/notify.ts's tests use.
        assert.doesNotMatch(note, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, what);
      }
    }
  });

  it("claims no send in either tense", () => {
    // The rule this family of tickets exists for (T91, T94, T110, T111, T120, T122, T129, T131): an
    // unconfigured deployment does not get to say anything is on its way. Not a bare /sent/, which "No
    // invites sent" is a refusal with.
    const MOTION = /on (?:the|its) way|sending|\bsent to\b|invites sent:(?! Sweet)|we(?:'| ha)ve (?:sent|emailed|texted)/i;
    for (const { what, committed } of BOTH_TENSES) {
      for (const handover of EVERY_HANDOVER) {
        assert.doesNotMatch(importInviteNote({ fault: CANNOT, committed, handover }), MOTION, `${what}, handover=${handover}`);
      }
    }
  });

  it("points at §8.1's fallback in both tenses, because that is what staff do instead", () => {
    for (const { what, committed } of BOTH_TENSES) {
      // T180 Where it is a fallback, which is the whole of what this ticket narrowed: every row the reason
      // speaks for is a patient a code can reach. The absent case is the same arm, because a caller with no
      // answer is read as `"all"` the way `handover` is read as true in lib/booking.ts and lib/inviteNote.ts.
      assert.match(importInviteNote({ fault: CANNOT, committed, handover: "all" }), /copy each link from the dashboard/i, what);
      assert.match(importInviteNote({ fault: CANNOT, committed }), /copy each link from the dashboard/i, `${what}, no answer given`);
    }
  });

  it("keeps T111's sentence word for word once the rows are created", () => {
    // The committed half was right, and this ticket is not undoing it.
    assert.equal(
      importInviteNote({ fault: CANNOT, committed: true, handover: "all" }),
      `No invites sent: ${CANNOT}. Copy each link from the dashboard instead.`,
    );
  });

  it("is a forecast on the preview, and names the press it is a forecast about", () => {
    // Where the bug was. The preview is the only screen on which closing the dialog is still an option, so
    // its sentence is in the future tense and says what pressing the button will cost — one trip through
    // the dashboard per row, which on an import is the whole day.
    const note = importInviteNote({ fault: CANNOT, committed: false, handover: "all" });
    assert.equal(note, `No invites will be sent: ${CANNOT}. Create these visits and you will have to copy each link from the dashboard.`);
    assert.doesNotMatch(note, /created|went out/i, "nothing has happened yet, and the line must not say it has");
  });

  it("gives the two tenses different words, so neither screen reads as the other", () => {
    for (const handover of EVERY_HANDOVER) {
      assert.notEqual(
        importInviteNote({ fault: CANNOT, committed: false, handover }),
        importInviteNote({ fault: CANNOT, committed: true, handover }),
        `handover=${handover}`,
      );
    }
  });
});

// T170 (§2.2, §5.3, §8.1) The paragraph above the preview, which until this ticket was JSX in the dialog and
// the last line of this family still claiming the code: "a row with a blank `channel` is created without an
// invite — hand those patients the link yourself, and opening it still sends them a code." The preview under
// it warns, row by row, about the rows with no number and no address — where there is nowhere to send one —
// and `desktop-provider-import-preview.png` held the general claim and the row that contradicts it in one
// frame.

/** The claim, not the word: `lib/visitIntake.test.ts`'s `CODE_IN_MOTION` and `lib/booking.test.ts`'s, over
 *  the third surface the rule reaches. */
const CODE_IN_MOTION = /sends? (?:them|you|the patient)|(?:we|it)(?:'| wi)ll (?:text|email|send)|code (?:is|will be|was) sent|code (?:is )?on (?:its|the) way/i;

describe("the import dialog's opening paragraph", () => {
  it("promises no code of a row the file may have given nothing to reach", () => {
    // Over the paragraph a reader sees rather than over the pieces: a clause coming back in any one of them
    // is the same bug, so the rule is stated about the whole of it.
    assert.doesNotMatch(importIntroText(), CODE_IN_MOTION);
    // And over each piece, so a rewording cannot pass by splitting the claim across two of them.
    for (const piece of Object.values(IMPORT_INTRO)) assert.doesNotMatch(piece, CODE_IN_MOTION, piece);
  });

  it("still says what a blank channel costs, and stops there (T180)", () => {
    const text = importIntroText();
    assert.match(text, /a row with a blank channel is created without an invite/i);
    // The half the preview is for: nothing is written until the rows have been checked (§2.2).
    assert.match(text, /checked before anything is created/i);
    // T180 And no longer §8.1's fallback. The clause was a flat claim about every blank-`channel` row — true
    // of none of them this deployment cannot send a code to, and the preview says so one line below, row by
    // row (`warningsFor`, lib/visitIntake.ts). The intro has no row to ask about: it is on screen before a
    // file has been chosen, so it cannot be qualified and the offer goes instead.
    assert.doesNotMatch(text, /hand those patients the link yourself/i);
    for (const piece of Object.values(IMPORT_INTRO)) assert.doesNotMatch(piece, OFFERS_HANDOVER, piece);
  });

  it("names every column parseVisitCsv maps, and nothing of the deployment's (§3.7, §10.6)", () => {
    for (const column of ["name", "phone", "email", "scheduled_at", "visit_type", "reason", "channel", "consent", "consent_at"]) {
      assert.ok(IMPORT_INTRO.columns.split(", ").includes(column), column);
    }
    assert.doesNotMatch(importIntroText(), /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
  });

  it("composes in the order the dialog renders the pieces in", () => {
    // The dialog sets `columns` and `column` in `<code>` and the prose around them, so the test reads the
    // same sentence the screen does.
    assert.equal(
      importIntroText(),
      `Columns: ${IMPORT_INTRO.columns}. ${IMPORT_INTRO.before} ${IMPORT_INTRO.column} ${IMPORT_INTRO.after}`,
    );
    assert.match(importIntroText(), /\. Every row/, "one sentence ends before the next begins");
  });
});

// ---------------------------------------------------------------------------------------------
// T180 (§2.2, §2.3, §3.7, §5.3, §8.1, §10.6) The rule the other three surfaces got in T173, T175 and T176,
// over the fourth — §2.2's bulk path — and in the shape those tickets left in lib/booking.test.ts: the whole
// dialog at once, over every row the import screen can be looking at, on a deployment that can send as well
// as on one that cannot.
//
// Why both arms. The gate configures no sender (§11.3), and with none every reason is present for every
// file, so a rule asserted only there passes on a dialog that says "cannot send" about everything. The
// configured arm is the one that can see the intro's half of this ticket: `IMPORT_INTRO` was a flat claim
// about every blank-`channel` row, so it offered the handover to a patient with nothing on file in an office
// with both backends — where there is no reason, no tally line, and nothing else on the screen to correct it.
//
// `DEV_MAIL_DIR` is what makes the gate's arm interesting rather than uniform: the code's email goes through
// `sendOrMailbox`, so a checkout naming it carries a code where no invite can (T05, T113). So in that arm a
// row with an address has a fault *and* a usable handover, and a row with only a number has neither — which
// is the pair the two-value rules get wrong.

/** An office with a sender behind both channels and no mailbox: what the pilot is, and what the gate is not.
 *  Each backend is selected by the setting it cannot send without (T94, T110); neither value is a credential. */
const SENDING = { EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199", DEV_MAIL_DIR: undefined };

/** And the gate's own configuration: no sender at all, and the mailbox `scripts/agent-check.sh` exports. */
const GATE = { EMAIL_FROM: undefined, SNS_ORIGINATION_NUMBER: undefined, DEV_MAIL_DIR: "e2e/.mail" };

/** Every pair of contact details a CSV row can carry, which is `lib/visitIntake.test.ts`'s
 *  `CONTACT_COMBINATIONS` and lib/booking.test.ts's: the rule is about all four. */
const CONTACT_COMBINATIONS = [
  { phone: null, email: null },
  { phone: "+14155550123", email: null },
  { phone: null, email: "sam@example.com" },
  { phone: "+14155550123", email: "sam@example.com" },
] as const;

/** Every value the `channel` column can reach `inviteFaults` with. A blank cell is `"none"` to the parser
 *  (lib/visitIntake.ts), and the two absences are what the type allows. */
const EVERY_CHANNEL = ["both", "sms", "email", "none", null, undefined] as const;

/** §8.1's handover as this dialog offers it, in both tenses and in the intro: the words that *offer* it, so
 *  `NO_HANDOVER_SENTENCE` — which contains "the link over" — is not matched by its own withdrawal. */
const OFFERS_HANDOVER = /copy each link from the dashboard|hand those patients the link yourself|copy the link from the dashboard/i;

/** Set these for one call and put the environment back, whichever way the assertion goes — `undefined`
 *  unsets, because an arm that means "no mailbox" has to hold whatever the shell arrived with. The same
 *  helper lib/booking.test.ts and lib/notify.test.ts use. */
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

/** Every line of the dialog that is this module's, for one file of rows, in one tense: the paragraph above
 *  the preview and the tally line per reason. The row warnings are `csvRowWarnings`'s and are held in
 *  lib/visitIntake.test.ts; what this block is about is the lines that used to contradict them. */
const dialogLines = (rows: readonly InviteBatchRow[], committed: boolean) => [
  importIntroText(),
  ...inviteFaults(rows).map(({ fault, handover }) => importInviteNote({ fault, handover, committed })),
];

describe("nothing in the import dialog offers a handover to a row no code can reach (T180)", () => {
  for (const [arm, env] of [["a deployment that can send", SENDING], ["the gate, which cannot", GATE]] as const) {
    it(`holds over ${arm}`, () => {
      withEnv(env, () => {
        for (const to of CONTACT_COMBINATIONS) {
          for (const channel of EVERY_CHANNEL) {
            for (const demo of [false, true]) {
              const where = `${arm}, channel=${channel}, demo=${demo}, to=${JSON.stringify(to)}`;
              // The fact the route answers each reason with, asked exactly as the route asks it
              // (`canHandOver`, app/api/visits/import/route.ts). One row, so the file's answer for whatever
              // reason it produces is this row's: "all" or "none", never "some".
              const handover = canHandOver({ ...to, demo });
              const rows = [{ channel, ...to, demo }];
              for (const { what, committed } of BOTH_TENSES) {
                const lines = dialogLines(rows, committed);
                for (const line of lines) {
                  if (!handover) {
                    // Criterion 1 and 2, over the whole dialog: the offer stands only where the link opens.
                    assert.doesNotMatch(line, OFFERS_HANDOVER, `${where}, ${what}: ${line}`);
                    // And no line puts the code itself in motion to a patient there is nowhere to send one.
                    assert.doesNotMatch(line, CODE_IN_MOTION, `${where}, ${what}: ${line}`);
                  }
                  // Criterion 5, on both arms: a half-configured office is the one most likely to be told
                  // about a variable, and the configured arm is where this ticket's intro half lives.
                  assert.doesNotMatch(line, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, line);
                }

                // The other direction, in the same block, so the rule cannot be satisfied by saying nothing
                // to anybody: a row a code *can* reach keeps §8.1's fallback word for word, in the tense
                // the screen is in. `inviteFaults` is empty wherever the deployment can send, so this is
                // asserted of the lines there are rather than of a line that must exist.
                if (handover) {
                  for (const { fault } of inviteFaults(rows)) {
                    assert.equal(
                      importInviteNote({ fault, handover: "all", committed }),
                      committed
                        ? `No invites sent: ${fault}. Copy each link from the dashboard instead.`
                        : `No invites will be sent: ${fault}. Create these visits and you will have to copy each link from the dashboard.`,
                      `${where}, ${what}`,
                    );
                  }
                }
              }
            }
          }
        }
      });
    });
  }

  it("is the ticket's own frame: the gate, a texted row, and the warning one line below it", () => {
    // `desktop-provider-import-preview.png` and `desktop-provider-import-created.png`. Three sentences about
    // one row, two of which offered the link and the third of which says it will not open. The row warning
    // is `csvRowWarnings`'s and is not this module's to produce, so it is quoted here as the thing the two
    // lines above it had to stop contradicting.
    withEnv(GATE, () => {
      const rows = [{ channel: "sms", phone: "+14155550123", email: null }];
      assert.equal(canHandOver({ phone: "+14155550123", email: null }), false, "no code can reach a number the gate cannot text");
      assert.deepEqual(inviteFaults(rows).map((f) => f.handover), ["none"]);
      for (const { what, committed } of BOTH_TENSES) {
        const lines = dialogLines(rows, committed);
        assert.equal(lines.length, 2, `${what}: the paragraph and one line for one reason`);
        assert.doesNotMatch(lines.join(" "), OFFERS_HANDOVER, what);
        assert.match(lines[1], new RegExp(`${NO_HANDOVER_SENTENCE.replace(/\./g, "\\.")}$`), `${what} ends on §8.1's withdrawal`);
        assert.ok(lines[1].includes(CANNOT), `${what} keeps the reason`);
      }
    });
  });

  it("a mixed file states the reason and stops, because either offer would be false for a row on it", () => {
    // The per-row shape criterion 3 asks to be settled. These two rows share one reason — both chose a text
    // in an office that cannot text — and the gate's mailbox can carry a code to the second one's address
    // and to nothing of the first's. Offering the handover would point the first patient's link at a door
    // that is locked, which is this ticket; withdrawing it would stop the second patient's link ever being
    // handed over, which is the same mistake pointing the other way.
    withEnv(GATE, () => {
      const rows = [
        { channel: "sms", phone: "+14155550123", email: null },
        { channel: "sms", phone: "+14155550124", email: "ada@example.com" },
      ];
      assert.deepEqual(inviteFaults(rows).map((f) => f.handover), ["some"]);
      for (const { what, committed } of BOTH_TENSES) {
        const line = dialogLines(rows, committed)[1];
        assert.equal(line, committed ? `No invites sent: ${CANNOT}.` : `No invites will be sent: ${CANNOT}.`, what);
        assert.doesNotMatch(line, OFFERS_HANDOVER, what);
        assert.doesNotMatch(line, new RegExp(NO_HANDOVER_SENTENCE.replace(/\./g, "\\.")), `${what} withdraws nothing from the row it is not true of`);
      }
    });
  });

  it("the configured deployment's half: the intro alone, and it offers nothing", () => {
    // Criterion 1's "wrong on every deployment, including a fully configured one". With both backends there
    // is no reason and so no tally line, so the paragraph is the whole of what this module puts on the
    // screen — and the row with nothing on file is still a row no code can reach.
    withEnv(SENDING, () => {
      const rows = [{ channel: "sms", phone: null, email: null }];
      assert.deepEqual(inviteFaults(rows), [], "nothing to say about a deployment that can send");
      assert.equal(canHandOver({ phone: null, email: null }), false);
      assert.deepEqual(dialogLines(rows, false), [importIntroText()]);
      assert.doesNotMatch(importIntroText(), OFFERS_HANDOVER);
    });
  });
});
