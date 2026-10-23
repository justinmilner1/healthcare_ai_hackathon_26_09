// Unit tests for what the dashboard row says after Send link and New link (T129, design §2.3, §5.5, §8.1,
// §12.1).
//
// The test the ticket was filed for is `no branch claims a send that is not happening`: New link said
// "New link sent." on every branch, including the deployment with no email and no SMS backend that this
// gate runs in — three lines below a Send link button that T120 had already taught to say the opposite.
// Both sentences are run through one rule here so the pair cannot drift again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotSendYet, NO_CONSENT_TO_MESSAGE } from "./delivery";
import { newLinkNote, sendLinkNote } from "./inviteNote";

/** Anything that reads as the message being in motion, the way lib/booking.test.ts states it for the card
 *  one screen over, plus the literal this ticket was filed about: none of it may appear where the route
 *  answered `queued: false`. Deliberately not a bare /sent/, which "No invite sent" is a refusal with. */
const MOTION = /on (?:the|its) way|sending|sent to|new link sent|we(?:'| ha)ve (?:sent|emailed|texted)/i;

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
