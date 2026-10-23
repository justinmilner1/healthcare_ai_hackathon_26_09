// What the dashboard row says after one of its invite buttons has been pressed (design §2.3, §8.1).
// Owner: Justin.
//
// Two buttons on one row post to the same route, read the same answer and write into the same note element:
// **Send link** and **New link**. T120 taught the first one that `queued` is `POST /api/invite`'s answer
// about *this deployment* and not about the queue, and left the second one three lines below it saying
// "New link sent." in an office with no email and no SMS backend at all — the state `scripts/agent-check.sh`
// and a fresh `.env` are both in. That is the sixth time the repo has had to say that an unconfigured
// deployment does not get to claim a send (T91, T94, T110, T111, T120), and the first time the claim and
// its correction were one press apart on the same row.
//
// So both sentences come from here, the way lib/booking.ts owns the two lines of the wizard's success card:
// neither can be reworded without the other being looked at, and a third caller of the route gets the same
// branch instead of inventing one.
//
// **New link** is the worse of the two to get wrong. It is the control staff reach for when the first
// invite did not arrive — which is *already* the case where nothing can send — and it kills the link the
// patient may still have in hand before anything is queued. So its sentence keeps the half that is true
// (the old link is dead) and hands the other half to the route's `reason`.
//
// The words for *why* nothing is going out are not here: they are that `reason`, which comes from
// lib/notify.ts and is spelled in lib/delivery.ts — staff's words for a gap in the deployment, naming no
// variable and no backend (§3.7, §10.6) — or `NO_CONSENT_TO_MESSAGE`, which is a practice's own choice and
// nobody's to fix. Both arrive here already written, so this module cannot tell them apart and does not try.
//
// Pure, no Prisma and no network: the dashboard is a client component, and lib/inviteNote.test.ts holds
// every branch (§12.1).

/** §8.1's fallback on this screen is a button a press away, not a link in a note under four of them. */
const FALLBACK = "Use Copy intake to give them";

/** What `POST /api/invite` answered, as much of it as a note depends on. Structural, so a test can pass two
 *  fields: `queued` is the claim about the deployment, `reason` is staff's words for why not. */
export type InviteAnswer = {
  /** Whether an invite is really going out: a sender exists and the patient consented to it. */
  queued?: boolean;
  /** Why nothing is going out, in staff's words, when nothing is. */
  reason?: string | null;
  /** The route's own failure, for the branch where there is no answer to read. */
  error?: string | null;
};

/**
 * The note after **Send link** (T120). The link itself is not in it: the row's own **Copy intake** is where
 * §8.1's fallback lives, and the sentence names it so the refusal points somewhere.
 */
export function sendLinkNote({ queued, reason, error }: InviteAnswer): string {
  if (queued) return "Sending now";
  if (reason) return `No invite sent: ${reason}. ${FALLBACK} the link.`;
  return `Not sent: ${error ?? "unknown error"}`;
}

/**
 * The note after **New link** (§5.5, T129). The old token is gone by the time the route answers — the swap
 * and `revokeSessions` both happen before anything is enqueued — so that half is said on every branch, and
 * first: it is the part staff have to act on, and it is true in both deployments.
 *
 * "the new link" rather than "the link" because the row has already been reloaded by the time this is read,
 * so **Copy intake** hands over the token that replaced it.
 */
export function newLinkNote({ queued, reason }: InviteAnswer): string {
  if (queued) return "New link sent. The old one no longer works.";
  const why = reason ? `: ${reason}` : "";
  return `The old link no longer works. No invite sent${why}. ${FALLBACK} the new link.`;
}
