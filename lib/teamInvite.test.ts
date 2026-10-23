// Unit tests for the practice settings invite card's two sentences (T131, design §2.1, §5.1, §8.1, §12.1).
//
// The test the ticket was filed for is `neither line claims an email this deployment cannot send`. The hint
// above the form was a literal — "They get an email asking them to sign in with this address" — over a note
// that branched, so an office with no email backend and no DEV_MAIL_DIR read the promise and then its own
// contradiction one press later. Both sentences are run through one rule here so the pair cannot drift
// again, and the rule is the invariant rather than the two strings: every line says what it claims, and
// nothing may claim a send or offer a sign-in where `canEmail` is false.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet } from "./delivery";
import { inviteHint, invitedNote, type InviteLine } from "./teamInvite";

/** Anything that reads as an email being on its way to the colleague, the way lib/inviteNote.test.ts states
 *  it for the dashboard's two notes. Deliberately not a bare /sent/ — "the email did not go out" is a
 *  refusal, and "was added" is about the row rather than the message. */
const MOTION = /they get an email|we(?:'| ha)ve (?:sent|emailed)|\bemailed to\b|invited \S+@/i;

/** The recovery this ticket is about: true on a deployment that can mail a magic link, a dead end on one
 *  that cannot (lib/auth.ts sendVerificationRequest throws, /provider/signin answers ?error=). */
const SIGN_IN_WITH_THAT_ADDRESS = /sign in with that address/i;

/** Every line the card can show, at both values of the one question it branches on. The note's own branches
 *  are in it too, because the invariant below is about the card and not about one sentence. */
const LINES = (canEmail: boolean): InviteLine[] => [
  inviteHint(canEmail),
  invitedNote({ email: "nurse@practice.test", canEmail, sent: true }),
  invitedNote({ email: "nurse@practice.test", canEmail, sent: false }),
  invitedNote({ email: "nurse@practice.test", canEmail, sent: false, error: "the address has bounced before" }),
];

describe("the invite card cannot disagree with itself about a send", () => {
  it("claims no email and offers no sign-in anywhere, when this deployment cannot mail one", () => {
    for (const line of LINES(false)) {
      assert.equal(line.claimsEmail, false, `claimsEmail on: ${line.text}`);
      assert.equal(line.offersSignIn, false, `offersSignIn on: ${line.text}`);
      assert.doesNotMatch(line.text, MOTION, "the claim this ticket was filed for");
      assert.doesNotMatch(line.text, SIGN_IN_WITH_THAT_ADDRESS, "the recovery that is a dead end there");
    }
  });

  it("says who to ask on every one of those lines, in staff's words and naming nothing of the deployment", () => {
    for (const line of LINES(false)) {
      assert.match(line.text, /ask whoever set it up for your office/i);
      // §3.7, §10.6: no variable, no backend and no credential on a practice's screen. The sentence is
      // lib/delivery.ts's, which is what keeps that true in one place.
      assert.ok(line.text.includes(cannotSendYet("email")), `the staff sentence is missing from: ${line.text}`);
      assert.doesNotMatch(line.text, /EMAIL_FROM|RESEND|DEV_MAIL_DIR|SES|SMTP|_API_KEY/);
    }
  });

  it("still offers the sign-in route wherever it really works", () => {
    for (const line of LINES(true)) assert.equal(line.offersSignIn, true, `offersSignIn on: ${line.text}`);
  });

  it("flags a claim exactly where the email went, and nowhere else", () => {
    assert.deepEqual(
      LINES(true).map((line) => line.claimsEmail),
      [true, true, false, false],
    );
  });
});

describe("inviteHint", () => {
  it("is unchanged where email can be sent", () => {
    assert.equal(
      inviteHint(true).text,
      "They get an email asking them to sign in with this address. Nothing in it signs anyone in — the one-time link comes to their own inbox.",
    );
  });

  it("says the dead end before the admin invites anybody", () => {
    const hint = inviteHint(false);
    assert.equal(hint.text, `${cannotSendYet("email")}. You can add someone and set their role, but nothing reaches them and they cannot sign in until it is fixed.`);
    // The role is still worth setting — the invite *is* the User row (lib/team.ts) — so the hint says what
    // the form does do rather than only what it cannot.
    assert.match(hint.text, /add someone and set their role/);
  });
});

describe("invitedNote", () => {
  const email = "benjamin@practice.test";

  it("is unchanged where the invite went out", () => {
    const note = invitedNote({ email, canEmail: true, sent: true });
    assert.equal(note.kind, "success");
    assert.equal(note.text, `Invited ${email}. They can sign in with that address now.`);
  });

  it("quotes a reached backend's refusal, and keeps the recovery that works there", () => {
    const note = invitedNote({ email, canEmail: true, sent: false, error: "a demo practice may only message a reserved address" });
    assert.equal(note.kind, "error");
    assert.equal(
      note.text,
      `${email} was added, but the email did not go out: a demo practice may only message a reserved address. Ask them to sign in with that address.`,
    );
  });

  it("says the row was made even on the branch where nobody can get in", () => {
    const note = invitedNote({ email, canEmail: false, sent: false });
    assert.equal(note.kind, "error");
    assert.equal(note.text, `${email} was added with that role, but they cannot sign in yet: ${cannotSendYet("email")}.`);
  });

  it("reads the address back on every branch, so the admin can see what was stored", () => {
    for (const canEmail of [true, false]) {
      for (const sent of [true, false]) assert.ok(invitedNote({ email, canEmail, sent }).text.includes(email));
    }
  });

  it("takes canEmail as the authority, so a route answering sent on an unsendable deployment cannot reopen the claim", () => {
    const note = invitedNote({ email, canEmail: false, sent: true });
    assert.equal(note.claimsEmail, false);
    assert.equal(note.offersSignIn, false);
  });
});
