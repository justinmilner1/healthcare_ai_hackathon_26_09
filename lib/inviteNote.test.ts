// Unit tests for what the dashboard row says after Send link and New link (T129, design §2.3, §5.5, §8.1,
// §12.1).
//
// The test the ticket was filed for is `no branch claims a send that is not happening`: New link said
// "New link sent." on every branch, including the deployment with no email and no SMS backend that this
// gate runs in — three lines below a Send link button that T120 had already taught to say the opposite.
// Both sentences are run through one rule here so the pair cannot drift again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet, NO_CONSENT_TO_MESSAGE, NO_CONTACT_ON_FILE } from "./delivery";
import { newLinkNote, sendLinkNote, sourInviteNote } from "./inviteNote";

/** Anything that reads as the message being in motion, the way lib/booking.test.ts states it for the card
 *  one screen over, plus the literal this ticket was filed about: none of it may appear where the route
 *  answered `queued: false`.
 *
 *  Deliberately not a bare /sent/, which "No invite sent" is a refusal with — and `\bsent to\b` and not
 *  `sent to`, because `NO_CONSENT_TO_MESSAGE` has "con|sent to" inside it and the refusal this rule exists
 *  to protect was failing its own test. */
const MOTION = /on (?:the|its) way|sending|\bsent to\b|new link sent|we(?:'| ha)ve (?:sent|emailed|texted)/i;

/** The two answers `POST /api/invite` gives when nothing is going out, which are different statements: one
 *  is the deployment's to fix and the other is the practice's own choice (lib/delivery.ts). */
const CANNOT = cannotSendYet("both");
const UNSENDABLE = [
  { what: "no sender in this deployment", reason: CANNOT },
  { what: "the practice chose not to contact them", reason: NO_CONSENT_TO_MESSAGE },
];

describe("sendLinkNote", () => {
  it("says the invite is moving only where the route said it is", () => {
    assert.equal(sendLinkNote({ queued: true }), "Sending now");
  });

  for (const { what, reason } of UNSENDABLE) {
    it(`quotes the route's reason and points at §8.1's fallback — ${what}`, () => {
      const note = sendLinkNote({ queued: false, reason });
      assert.equal(note, `No invite sent: ${reason}. Use Copy intake to give them the link.`);
      assert.doesNotMatch(note, MOTION);
    });
  }

  it("still reports a route that failed outright", () => {
    assert.equal(sendLinkNote({ queued: false, error: "boom" }), "Not sent: boom");
    assert.equal(sendLinkNote({}), "Not sent: unknown error");
  });
});

describe("newLinkNote", () => {
  it("tells a configured deployment the new link went out, unchanged", () => {
    assert.equal(newLinkNote({ queued: true }), "New link sent. The old one no longer works.");
  });

  for (const { what, reason } of UNSENDABLE) {
    it(`claims no send where nothing can send, and keeps the half that is true — ${what}`, () => {
      const note = newLinkNote({ queued: false, reason });
      assert.equal(
        note,
        `The old link no longer works. No invite sent: ${reason}. Use Copy intake to give them the new link.`,
      );
      assert.doesNotMatch(note, MOTION, "the claim this ticket was filed for");
    });
  }

  it("says the old link is dead on every branch, because the route kills it before it queues anything", () => {
    for (const answer of [{ queued: true }, { queued: false, reason: CANNOT }, { queued: false }]) {
      assert.match(newLinkNote(answer), /old (?:link|one) no longer works/);
    }
  });

  it("names §8.1's fallback, and the token the row now carries rather than the one it replaced", () => {
    for (const answer of [{ queued: false, reason: CANNOT }, { queued: false }]) {
      assert.match(newLinkNote(answer), /Use Copy intake to give them the new link\.$/);
    }
  });

  it("still refuses the claim with no reason to quote", () => {
    const note = newLinkNote({ queued: false });
    assert.equal(note, "The old link no longer works. No invite sent. Use Copy intake to give them the new link.");
    assert.doesNotMatch(note, MOTION);
  });

  it("keeps the two reasons apart, because only one of them is anybody's to fix", () => {
    const [deployment, consent] = UNSENDABLE.map(({ reason }) => newLinkNote({ queued: false, reason }));
    assert.notEqual(deployment, consent);
  });
});

// ---------------------------------------------------------------------------------------------
// T173 (§2.2, §2.3, §5.3, §8.1) The patient both sentences were still wrong for after they had learnt to
// refuse the send. §8.1's fallback is "hand the link over", the link opens on a six-digit code sent to the
// number or address on file, and this patient has neither — so **Send link** answered "No invite sent: …
// Use Copy intake to give them the link.", pointing at a door that is locked. On a deployment with a sender
// it did not even refuse: `inviteReach` claimed both channels, so the note read "Sending now".

/** What offers the handover, as opposed to the clause that withdraws it. */
const OFFERS_HANDOVER = /Use Copy intake/;

/** The route's answer for that patient: `queued: false` with §2.2's gap as the reason, and the handover
 *  fact off the same patient row (`channelsFor`, app/api/invite/route.ts). */
const NOBODY = { queued: false, reason: NO_CONTACT_ON_FILE, handover: false };

describe("the two notes for a patient with nothing on file (T173)", () => {
  it("quotes the gap and withdraws the handover instead of naming Copy intake", () => {
    assert.equal(
      sendLinkNote(NOBODY),
      `No invite sent: ${NO_CONTACT_ON_FILE}. Handing the link over will not get this patient in either.`,
    );
    assert.equal(
      newLinkNote(NOBODY),
      `The old link no longer works. No invite sent: ${NO_CONTACT_ON_FILE}. Handing the link over will not get this patient in either.`,
    );
    for (const note of [sendLinkNote(NOBODY), newLinkNote(NOBODY)]) {
      assert.doesNotMatch(note, MOTION, note);
      assert.doesNotMatch(note, OFFERS_HANDOVER, note);
    }
  });

  it("keeps the half that is true of **New link**, which is why staff pressed it", () => {
    // The old token is gone before the route answers, on every branch (§5.5) — and this is the press staff
    // reach for *because* the first invite never arrived, which for this patient it never could have.
    assert.match(newLinkNote(NOBODY), /^The old link no longer works\./);
  });

  it("still withdraws the handover when the reason is somebody else's", () => {
    // `handover` is a fact about the patient and not about the send, so it holds whichever of the three
    // reasons the route quotes: the practice's own choice and the deployment's gap are both reachable for a
    // patient with nothing on file (a "Do not message" row, an unconfigured office).
    for (const reason of [NO_CONSENT_TO_MESSAGE, CANNOT, NO_CONTACT_ON_FILE]) {
      for (const note of [sendLinkNote({ queued: false, reason, handover: false }), newLinkNote({ queued: false, reason, handover: false })]) {
        assert.doesNotMatch(note, OFFERS_HANDOVER, note);
        assert.match(note, /will not get this patient in either\.$/, note);
      }
    }
  });

  it("leaves §8.1's fallback alone for every patient it is a fallback for", () => {
    // Which is every other patient, and the reason the field withdraws it on an explicit `false` only: an
    // answer without it is the one these notes have always been given and reads unchanged.
    for (const handover of [true, undefined]) {
      for (const note of [sendLinkNote({ queued: false, reason: CANNOT, handover }), newLinkNote({ queued: false, reason: CANNOT, handover })]) {
        assert.match(note, OFFERS_HANDOVER, note);
      }
    }
    // And a send that is really going out says so whatever this field holds: it is about the handover.
    assert.equal(sendLinkNote({ queued: true, handover: false }), "Sending now");
    assert.equal(newLinkNote({ queued: true, handover: false }), "New link sent. The old one no longer works.");
  });

  it("says nothing about the two fields that would fix it, which the row's own line owns", () => {
    // The T170 split: the remedy belongs to the one line that owns it, and on this screen that is
    // `NO_CODE_TO_SEND` in the Messages cell (lib/delivery.ts, app/provider/dashboard.tsx). A note under
    // four buttons repeating it would be the same fact twice on one row.
    for (const note of [sendLinkNote(NOBODY), newLinkNote(NOBODY)]) {
      assert.doesNotMatch(note, /add a (?:phone|number)|add an? (?:email|address)|call them/i, note);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T179 (§2.3, §2.6, §5.3, §8.1) The fourth surface reading `POST /api/invite`, and the only one that never
// read `handover`: the clinician's brief wrote its own three sentences and ended every no-send branch on
// "Share the link directly: http://…/s/…". For the patient T175 was filed about — one detail on file, on the
// channel this deployment has no sender behind — the brief offered that link while the dashboard row for the
// same visit said "No code can reach this patient, so their link will not open — call them".

/** A link of the shape `intakeLink` builds (lib/notify.ts): what the brief printed, and what the offer is. */
const LINK = "http://localhost:3000/s/Zr4k9QpL2mN7vX1c";

/** What offers the handover on *this* screen: the link itself, because the brief has no **Copy intake**
 *  to name. A separate rule from the T173 one above for that reason — the two screens offer it differently. */
const OFFERS_THE_LINK = /Share (?:the link|it) directly|\/s\//;

/** The three answers the route gives when nothing is going out, for the patient no code can reach: a reason,
 *  the route's own failure, and neither. `handover: false` is `canHandOver`'s whole question
 *  (app/api/invite/route.ts), and the link is on the answer in every one of them that has an answer. */
const NO_SEND = [
  { what: "a reason to quote", answer: { queued: false, reason: CANNOT, link: LINK, handover: false }, lede: `No invite sent: ${CANNOT}.` },
  { what: "the route's own failure", answer: { queued: false, error: "boom", link: LINK, handover: false }, lede: "Couldn't send the link: boom." },
  { what: "neither", answer: { queued: false, link: LINK, handover: false }, lede: "Couldn't send the link automatically." },
];

describe("sourInviteNote", () => {
  it("keeps the link and the offer for every patient §8.1's fallback is a fallback for", () => {
    // The direction e2e/invite.spec.ts pins on the seeded demo practice, and the one that must not move: an
    // answer with no `handover` field at all is what this note was always handed, and reads unchanged.
    for (const handover of [true, undefined]) {
      assert.equal(
        sourInviteNote({ queued: false, reason: CANNOT, link: LINK, handover }),
        `No invite sent: ${CANNOT}. Share the link directly: ${LINK}`,
      );
    }
  });

  it("says a send that is going out is going out, whatever this field holds", () => {
    // The route cannot answer `queued: true` with `handover: false` — it queues only on a channel
    // `inviteReach` left open, and an open channel is a code's way in — but the branch is pinned either way.
    for (const handover of [true, undefined, false]) {
      assert.equal(
        sourInviteNote({ queued: true, link: LINK, handover }),
        `Sending the link to this patient now. Share it directly if you'd rather: ${LINK}`,
      );
    }
  });

  for (const { what, answer, lede } of NO_SEND) {
    it(`withdraws the offer instead of printing a link that will not open — ${what}`, () => {
      const note = sourInviteNote(answer);
      assert.equal(note, `${lede} Handing the link over will not get this patient in either.`);
      assert.doesNotMatch(note, MOTION, note);
      assert.doesNotMatch(note, OFFERS_THE_LINK, note);
    });
  }

  it("withdraws it whichever of the three reasons closed the channel", () => {
    // `handover` is a fact about the patient and the deployment rather than about the send, so the clause
    // does not depend on who refused: the practice's own choice, the deployment's gap, and §2.2's missing
    // detail all reach this screen.
    for (const reason of [NO_CONSENT_TO_MESSAGE, CANNOT, NO_CONTACT_ON_FILE]) {
      const note = sourInviteNote({ queued: false, reason, link: LINK, handover: false });
      assert.doesNotMatch(note, OFFERS_THE_LINK, note);
      assert.match(note, /will not get this patient in either\.$/, note);
    }
  });

  it("is the one sentence the other three surfaces end on, not a fourth wording of it", () => {
    const brief = sourInviteNote({ queued: false, reason: CANNOT, link: LINK, handover: false });
    const row = sendLinkNote({ queued: false, reason: CANNOT, handover: false });
    const tail = /Handing the link over will not get this patient in either\.$/;
    assert.match(brief, tail);
    assert.match(row, tail);
  });

  it("says nothing the screen already says, and nothing about the deployment's innards", () => {
    // The T170 split: the remedy and the consequence belong to the lines that own them, which on this
    // ticket's patient are the dashboard row's. §3.7 and §10.6: no backend, variable or credential.
    for (const { answer } of NO_SEND) {
      const note = sourInviteNote(answer);
      assert.doesNotMatch(note, /call them|add a (?:phone|number)|add an? (?:email|address)/i, note);
      assert.doesNotMatch(note, /SES|SNS|SMS_|MAIL_|AWS|secret|credential|environment variable/i, note);
    }
  });

  it("offers nothing where there is no link to offer, rather than printing `undefined`", () => {
    // The route's own failures answer `{ error }` and no link (app/api/invite/route.ts), and the component's
    // template read `${d.link}` on the branch with neither a reason nor an error.
    assert.equal(sourInviteNote({ queued: false, error: "boom" }), "Couldn't send the link: boom.");
    assert.equal(sourInviteNote({}), "Couldn't send the link automatically.");
    for (const note of [sourInviteNote({ queued: false, error: "boom" }), sourInviteNote({})]) {
      assert.doesNotMatch(note, /undefined/, note);
    }
  });
});
