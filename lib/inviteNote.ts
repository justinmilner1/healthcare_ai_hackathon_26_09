// What a screen says after one of the invite buttons on it has been pressed (design §2.3, §2.6, §8.1).
// Owner: Justin.
//
// Three sentences, three buttons, one route: the dashboard row's **Send link** and **New link**, and the
// clinician's brief's own **Send link** (T179, at the bottom of this file).
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
// T173 found the one patient both sentences were wrong for even when they refused the send: §8.1's fallback
// is "hand the link over", and the link does not open without a six-digit code, and a patient with neither a
// number nor an address has nowhere for one to go (§2.3, §5.3). So **Send link** read "No invite sent: … Use
// Copy intake to give them the link." on a row whose Copy intake hands over a link that will not open — a
// remedy pointing at a door that is locked, which is the same shape of claim as the send itself. The route
// answers whether the handover is a way in (`handover` below); the clause that withdraws it is
// lib/delivery.ts's, shared with the booking step and card that say it three presses earlier.
//
// T175 widened that answer rather than these sentences: having a detail on file is only the first of the
// four things between this patient and a code, and the same row has been reading all four since T121. So the
// row could carry "No code can reach this patient, so their link will not open" and, one press later, a note
// from here naming **Copy intake** — one row saying both. `POST /api/invite` now answers `handover` with
// `canHandOver` (lib/notify.ts), which is that whole question, and the branch below is unchanged: it was
// always right about what to do with the answer, and wrong only about how narrow the answer was.
//
// T179 added the third sentence, from the fourth surface reading `handover` — the one that had never read
// it. It is at the bottom of the file rather than beside the two above because it is the only one that
// prints the link instead of naming the button that hands it over, and that is what the ticket turned out to
// be about; its own comment says why the link goes with the offer there.
//
// Pure, no Prisma and no network: the dashboard and the brief are both client components, and
// lib/inviteNote.test.ts holds every branch (§12.1).

import { NO_HANDOVER_SENTENCE } from "./delivery";

/** §8.1's fallback on this screen is a button a press away, not a link in a note under four of them. */
const FALLBACK = "Use Copy intake to give them";

/** T173, T175 And what stands in its place where it is not a fallback: the sentence is lib/delivery.ts's, so
 *  this note, step 3's and the success card's are one wording of one fact — and since T175 one constant,
 *  rather than the same capital derived in three modules. */
const NO_FALLBACK = NO_HANDOVER_SENTENCE;

/** What `POST /api/invite` answered, as much of it as a note depends on. Structural, so a test can pass two
 *  fields: `queued` is the claim about the deployment, `reason` is staff's words for why not. */
export type InviteAnswer = {
  /** Whether an invite is really going out: a sender exists and the patient consented to it. */
  queued?: boolean;
  /** Why nothing is going out, in staff's words, when nothing is. */
  reason?: string | null;
  /** The route's own failure, for the branch where there is no answer to read. */
  error?: string | null;
  /** T179 The visit's own intake link, for the one note that prints it rather than naming the button that
   *  hands it over (`sourInviteNote` below). Optional, because the branch where the route failed outright
   *  has no answer to take it from — and a note that cannot quote the link says nothing about it instead of
   *  printing `undefined`, which is what the component's own template did on that branch. */
  link?: string;
  /** T173, T175 Whether handing the link over is a way in: false wherever the code the link needs cannot
   *  reach this patient at all (§2.3, §5.3) — no destination on file, none §13.4 allows, none §8.1 leaves
   *  open, or none this deployment has a sender behind. `POST /api/invite` answers it off the patient row it
   *  already has in hand (`canHandOver`, lib/notify.ts). Optional and read as true when absent: it is a fact
   *  about the patient and the deployment rather than about the send, and a note with no answer for it keeps
   *  §8.1's fallback, which is right for every patient a code can reach. */
  handover?: boolean;
};

/**
 * The note after **Send link** (T120). The link itself is not in it: the row's own **Copy intake** is where
 * §8.1's fallback lives, and the sentence names it so the refusal points somewhere.
 */
export function sendLinkNote({ queued, reason, error, handover }: InviteAnswer): string {
  if (queued) return "Sending now";
  if (reason) return `No invite sent: ${reason}. ${handover === false ? NO_FALLBACK : `${FALLBACK} the link.`}`;
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
export function newLinkNote({ queued, reason, handover }: InviteAnswer): string {
  if (queued) return "New link sent. The old one no longer works.";
  const why = reason ? `: ${reason}` : "";
  // T173 The half that is true is still said first and on every branch — the old link is dead — and what
  // changes is only the remedy at the end of it. Pressing **New link** for a patient nothing can reach is
  // the press this matters most on: it is what staff reach for when the first invite did not arrive, and
  // for this patient it never could have.
  const fallback = handover === false ? NO_FALLBACK : `${FALLBACK} the new link.`;
  return `The old link no longer works. No invite sent${why}. ${fallback}`;
}

// ---------------------------------------------------------------------------------------------

/**
 * §2.6, §8.1, T179 The same note on the clinician's brief, which was the fourth surface reading this route's
 * answer and the only one that never read `handover`.
 *
 * It is here rather than in app/provider/[id]/sour.tsx for the reason the two above are here: three screens
 * state one fact, and the component that writes its own sentences is the one that drifts. For a patient with
 * one detail on file on the channel this deployment has no sender behind, the brief read "No invite sent:
 * Sweet Spot cannot send texts yet … Share the link directly: http://…/s/…" while the dashboard row for the
 * same visit read "No code can reach this patient, so their link will not open — call them" — one visit, two
 * screens, opposite answers about whether that link opens.
 *
 * **The link goes with the offer on this screen, rather than staying under the clause that withdraws it.**
 * That is the decision §2.6 forces and the other three surfaces have already taken: the dashboard's note
 * names **Copy intake**, a button a press away, so withdrawing the offer there leaves the link itself where
 * it was; this screen has no such control, so the link in this note *is* the offer, and a bare `/s/` URL
 * under "Handing the link over will not get this patient in either." is the same contradiction one sentence
 * apart. T177 took the success card's `.patient-link-card` away on exactly this answer for exactly this
 * reason. The link is not lost with it — the visit and its link are the dashboard's (§2.2), which is where
 * §8.1's fallback lives for every patient it is a fallback for.
 *
 * `queued: true` keeps every word it had: a send going out is a send going out, and the route cannot answer
 * it alongside `handover: false` — it queues only on a channel `inviteReach` left open, and an open channel
 * is a code's way in (`codeReach`, lib/notify.ts).
 */
export function sourInviteNote({ queued, reason, error, link, handover }: InviteAnswer): string {
  if (queued) return `Sending the link to this patient now.${share(link, " Share it directly if you'd rather:")}`;
  // The clause in place of the offer, on all three of the no-send branches rather than only on `reason`:
  // `handover` is a fact about the patient and the deployment, so it does not depend on which of the three
  // the route happened to answer with (T173's rule for the two notes above).
  const remedy = handover === false ? ` ${NO_FALLBACK}` : share(link, " Share the link directly:");
  if (reason) return `No invite sent: ${reason}.${remedy}`;
  if (error) return `Couldn't send the link: ${error}.${remedy}`;
  return `Couldn't send the link automatically.${remedy}`;
}

/** §8.1's fallback on this screen is the link itself, so a note with no link to quote offers nothing. */
function share(link: string | undefined, lead: string): string {
  return link ? `${lead} ${link}` : "";
}
