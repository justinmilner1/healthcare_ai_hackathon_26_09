// What the practice settings screen's invite card says, before and after an invite (design §2.1, §5.1,
// §8.1). Owner: identity.
//
// The card is a hint above the form and a note under it, about one thing: whether a colleague who has just
// been given a role will be emailed, and how they get in. They disagreed. The hint was a literal —
//
//   They get an email asking them to sign in with this address.
//
// — shown before the admin does anything, and the note already branched on what the route answered. So on a
// deployment with no email backend and no `DEV_MAIL_DIR`, which is the state a fresh `.env` is in, the card
// contradicted itself across one press. That is the eighth time this repo has had to say that an
// unconfigured deployment does not get to claim a send (T91, T94, T110, T111, T120, T122, T129), and the
// first time on the staff path.
//
// It is the worse path to get it wrong on. The patient path has §8.1's fallback — the link is on the screen
// and staff read it out at the desk — and this one has no fallback at all: the invite *is* the User row
// (lib/team.ts), the nudge email is only a nudge, and the thing that actually signs the colleague in is a
// magic link they ask for themselves (§5.1). With no sender, `sendVerificationRequest` throws and
// `/provider/signin` answers `?error=` (lib/auth.ts, T113), so "Ask them to sign in with that address" — the
// note's own recovery — does not work either, and `POST /api/practice/users` hands back no link to forward.
// The role is set, and nobody can get in.
//
// So both sentences come from here, from one value, the way lib/booking.ts owns the two lines of the wizard's
// success card (T122) and lib/inviteNote.ts owns the two notes under the dashboard's invite buttons (T129).
// Neither can be reworded without the other being looked at, and the invariant is checked as data rather
// than as prose: every line says whether it claims an email and whether it offers a sign-in, and
// lib/teamInvite.test.ts holds both to `canEmail`.
//
// The words for a deployment that cannot send are `cannotSendYet` from lib/delivery.ts — staff's own words,
// naming no variable, no backend and no credential on a practice's screen (§3.7, §10.6) — so there is one
// copy of that sentence in the repo and the invite card reads the same as the booking wizard did.
//
// Pure, no Prisma and no network: the settings screen is a client component, and the one value it branches on
// is settled from the environment by `canSendOrMailbox` (lib/mailer.ts) in the server component above it.

import { cannotSendYet } from "./delivery";

/** The one sentence for a deployment with nowhere to put an email. §8.1's two backends amount to this for an
 *  office nobody has set up yet, and it is `cannotSendYet`'s, not ours. */
const CANNOT_EMAIL = cannotSendYet("email");

/**
 * One sentence of the invite card, and what it claims — which is the part the two are held to.
 *
 * Both flags are about the same deployment, so neither may be true where `canEmail` is false: an email that
 * cannot be sent cannot be claimed, and a sign-in that needs a magic link cannot be offered.
 */
export type InviteLine = {
  /** The sentence itself, as the card shows it. */
  text: string;
  /** Whether it tells the admin an email reaches their colleague. */
  claimsEmail: boolean;
  /** Whether it tells the admin their colleague can get themselves in by asking for a sign-in link. */
  offersSignIn: boolean;
};

/**
 * The hint above the invite form, before the admin has done anything (§2.1).
 *
 * `canEmail` is `canSendOrMailbox()` and not `emailConfig()`, because the team invite really does land in the
 * local mailbox where `DEV_MAIL_DIR` names one (lib/mailer.ts `sendTeamInvite`) — and so does the sign-in
 * link the colleague then asks for, which is the half that decides whether they can get in at all. One
 * question answers both, which is why there is one value here and not two.
 */
export function inviteHint(canEmail: boolean): InviteLine {
  // Unchanged from before the ticket: where email works, this was already true.
  if (canEmail) {
    return {
      text: "They get an email asking them to sign in with this address. Nothing in it signs anyone in — the one-time link comes to their own inbox.",
      claimsEmail: true,
      offersSignIn: true,
    };
  }
  return {
    text: `${CANNOT_EMAIL}. You can add someone and set their role, but nothing reaches them and they cannot sign in until it is fixed.`,
    claimsEmail: false,
    offersSignIn: false,
  };
}

/** What `POST /api/practice/users` answered, plus the address the admin typed and the question above. */
export type InvitedFacts = {
  /** The address, as the admin typed it — the note reads it back so they can see what was stored. */
  email: string;
  /** The same value the hint was written from. */
  canEmail: boolean;
  /** Whether the nudge email really went out (`sent` from the route). */
  sent: boolean;
  /** The route's own reason when it did not, which is sometimes a backend's words. */
  error?: string | null;
};

/** The note under the form, with the class the card picks from `kind` (`ss-success` / `ss-error`). */
export type InvitedNote = InviteLine & { kind: "success" | "error" };

/**
 * The note after one invite (§2.1, §5.1, §8.1).
 *
 * `canEmail` is read before `sent`, and that order is the point rather than a convenience: with nowhere for
 * an email to go, nothing was sent and nothing the admin can do will let this colleague sign in, so that is
 * the whole of what the note has to say. It therefore cannot claim a send the hint has just denied.
 *
 * The route's `error` is dropped on that branch alone. On it the error is the sender's own refusal — "SES is
 * not configured", a missing key — which is the deployment's internals on a practice's screen (§3.7, §10.6)
 * and says less than `CANNOT_EMAIL` does. Everywhere else a backend was reached and its reason is worth
 * quoting: §13.4's demo rule and §8.1's bounce are already staff's words.
 *
 * And on that branch "Ask them to sign in with that address" is gone, which is what the ticket is about: it
 * is a dead end there (lib/auth.ts), and sending an admin down it is worse than telling them nothing.
 */
export function invitedNote({ email, canEmail, sent, error }: InvitedFacts): InvitedNote {
  if (!canEmail) {
    return {
      kind: "error",
      text: `${email} was added with that role, but they cannot sign in yet: ${CANNOT_EMAIL}.`,
      claimsEmail: false,
      offersSignIn: false,
    };
  }
  if (sent) {
    return {
      kind: "success",
      text: `Invited ${email}. They can sign in with that address now.`,
      claimsEmail: true,
      offersSignIn: true,
    };
  }
  // A sender exists and refused this one message: the row is made, the nudge is not, and the colleague can
  // still ask for their own link — so the recovery this offers is one that works.
  return {
    kind: "error",
    text: `${email} was added, but the email did not go out${error ? `: ${error}` : ""}. Ask them to sign in with that address.`,
    claimsEmail: false,
    offersSignIn: true,
  };
}
