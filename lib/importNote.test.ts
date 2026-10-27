// Unit tests for the two tenses of §2.2's import dialog's invite line (T135, design §2.2, §8.1, §12.1).
//
// The test the ticket was filed for is `the preview says it before the button, not only after it`: T111
// wrote the committed sentence and left the preview — the screen a whole day of patients is decided on —
// with nothing to say, so the correction arrived once the rows were already written. Both tenses are run
// through one rule here so the pair cannot drift apart again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet } from "./delivery";
import { IMPORT_INTRO, importInviteNote, importIntroText } from "./importNote";

/** The reason itself always comes from lib/delivery.ts, through `inviteFaults` (lib/notify.ts). This module
 *  is only ever told it, so the tests pass what the import route really passes. */
const CANNOT = cannotSendYet("sms");

const BOTH_TENSES = [
  { what: "the preview, before anything is written", committed: false },
  { what: "the result, after the rows went in", committed: true },
];

describe("the import dialog's line about invites that cannot go out", () => {
  it("carries the reason unchanged, in staff's words, in both tenses", () => {
    for (const { what, committed } of BOTH_TENSES) {
      const note = importInviteNote({ fault: CANNOT, committed });
      assert.ok(note.includes(CANNOT), `${what} quotes the deployment's own sentence`);
      // §3.7, §10.6: this module adds words around that sentence and must not add a variable or a backend
      // to it. The same shape lib/delivery.ts's and lib/notify.ts's tests use.
      assert.doesNotMatch(note, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, what);
    }
  });

  it("claims no send in either tense", () => {
    // The rule this family of tickets exists for (T91, T94, T110, T111, T120, T122, T129, T131): an
    // unconfigured deployment does not get to say anything is on its way. Not a bare /sent/, which "No
    // invites sent" is a refusal with.
    const MOTION = /on (?:the|its) way|sending|\bsent to\b|invites sent:(?! Sweet)|we(?:'| ha)ve (?:sent|emailed|texted)/i;
    for (const { what, committed } of BOTH_TENSES) {
      assert.doesNotMatch(importInviteNote({ fault: CANNOT, committed }), MOTION, what);
    }
  });

  it("points at §8.1's fallback in both tenses, because that is what staff do instead", () => {
    for (const { what, committed } of BOTH_TENSES) {
      assert.match(importInviteNote({ fault: CANNOT, committed }), /copy each link from the dashboard/i, what);
    }
  });

  it("keeps T111's sentence word for word once the rows are created", () => {
    // The committed half was right, and this ticket is not undoing it.
    assert.equal(
      importInviteNote({ fault: CANNOT, committed: true }),
      `No invites sent: ${CANNOT}. Copy each link from the dashboard instead.`,
    );
  });

  it("is a forecast on the preview, and names the press it is a forecast about", () => {
    // Where the bug was. The preview is the only screen on which closing the dialog is still an option, so
    // its sentence is in the future tense and says what pressing the button will cost — one trip through
    // the dashboard per row, which on an import is the whole day.
    const note = importInviteNote({ fault: CANNOT, committed: false });
    assert.equal(note, `No invites will be sent: ${CANNOT}. Create these visits and you will have to copy each link from the dashboard.`);
    assert.doesNotMatch(note, /created|went out/i, "nothing has happened yet, and the line must not say it has");
  });

  it("gives the two tenses different words, so neither screen reads as the other", () => {
    assert.notEqual(importInviteNote({ fault: CANNOT, committed: false }), importInviteNote({ fault: CANNOT, committed: true }));
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

  it("still says what a blank channel costs, and points at §8.1's fallback", () => {
    const text = importIntroText();
    assert.match(text, /a row with a blank channel is created without an invite/i);
    assert.match(text, /hand those patients the link yourself/i);
    // The half the preview is for: nothing is written until the rows have been checked (§2.2).
    assert.match(text, /checked before anything is created/i);
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
