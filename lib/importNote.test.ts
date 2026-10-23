// Unit tests for the two tenses of §2.2's import dialog's invite line (T135, design §2.2, §8.1, §12.1).
//
// The test the ticket was filed for is `the preview says it before the button, not only after it`: T111
// wrote the committed sentence and left the preview — the screen a whole day of patients is decided on —
// with nothing to say, so the correction arrived once the rows were already written. Both tenses are run
// through one rule here so the pair cannot drift apart again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet } from "./delivery";
import { importInviteNote } from "./importNote";

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
