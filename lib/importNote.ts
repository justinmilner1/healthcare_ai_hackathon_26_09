// What §2.2's CSV import says about invites that cannot go out (design §2.2, §8.1). Owner: identity.
//
// One sentence with two tenses, because the import dialog shows the same block twice: once on the preview,
// which is the screen staff decide on, and once after the button, which is the screen they read the result
// on. T111 wrote the second one and left the first silent, so in an office with no SMS backend — the state
// `scripts/agent-check.sh` and a fresh `.env` are both in — a day of texted invites read, one press apart:
//
//   3 ready to create, 2 to fix.                     Text message · Over the phone
//   3 created.  No invites sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office.
//               Copy each link from the dashboard instead.
//
// That is the ninth time this repo has had to say that an unconfigured deployment does not get to claim a
// send (T91, T94, T110, T111, T120, T122, T129, T131), and the first time on the *bulk* path: by the time
// the correction arrives the rows are written, and the remedy it names is one trip through the dashboard
// per row. Nothing on the preview gave anyone the chance to decide not to import this way.
//
// T180 And the remedy itself, which both tenses named unconditionally: "copy each link from the dashboard"
// is §8.1's fallback, and §2.3 makes the link open on a six-digit code reaching the patient — so for a row
// no code can reach it points at a door that is locked. T173, T175 and T176 took that offer off the wizard,
// the success card and the dashboard row; here it stood one line above the preview's own row warning saying
// the link will not open. `handover` below is the branch, and the hard part of it is that the answer is per
// row while the sentence is per import: the rule, and why neither two-value rule is honest, is written where
// the branch is.
//
// So both tenses come from here, from one branch on one value, the way lib/booking.ts owns the two lines of
// the wizard's success card and lib/inviteNote.ts the two notes under a dashboard row: neither can be
// reworded without the other being looked at.
//
// The words for *why* nothing can go out are not here. They are the route's `inviteFaults`, which comes
// from lib/notify.ts and is spelled in lib/delivery.ts — staff's words for a gap in the deployment, naming
// no variable and no backend (§3.7, §10.6).
//
// Pure, and in lib/ rather than in the dialog, so every branch is held to in a unit test (§12.1). The
// dashboard is a client component, so nothing here may pull in Prisma.

import { NO_HANDOVER_SENTENCE } from "./delivery";

/** §8.1's fallback on this screen is a button on every imported row — **Copy intake** — so both tenses
 *  point at it. Named once, because the two sentences differ in when the trip has to be made and not in
 *  where it goes. */
const FALLBACK = "copy each link from the dashboard";

/**
 * T180 Whether §8.1's fallback is a way in for the rows one of `inviteFaults`' reasons speaks for (§2.3,
 * §5.3, §8.1).
 *
 * `canHandOver` (lib/notify.ts) is the question, and on the other three surfaces it is a boolean because
 * each of them is about one patient. A batch is not: the line is one sentence and the answer is per row, so
 * the three outcomes are named rather than collapsed into a yes-or-no that would be wrong for one of them.
 *
 * `"some"` is the whole reason this is three values and not two, and `importInviteNote` below says why
 * neither two-value rule would do.
 */
export type BatchHandover = "all" | "some" | "none";

/**
 * The line under the import tally for one of `inviteFaults`' reasons (lib/notify.ts).
 *
 * `committed` is the whole branch, and it is a tense and not a different fact: the preview is a forecast
 * staff can still act on by closing the dialog, and the result is a report on rows that exist. So the
 * forecast names the press it is a forecast about — the cost of pressing the button is what the preview was
 * missing — and the report keeps T111's sentence word for word, because it was right.
 *
 * T180 `handover` is the second branch, and it is the one this family of tickets is about: §8.1's fallback
 * is the claim that the link opens, the link opens on a six-digit code reaching the patient (§2.3, §5.3),
 * and for the rows no code can reach, "copy each link from the dashboard" sends staff to a door that is
 * locked. T173, T175 and T176 withdrew that offer from the wizard, the success card and the dashboard row;
 * this is the bulk path, where the same sentence stood directly above a row warning saying the link will not
 * open (`warningsFor`, lib/visitIntake.ts).
 *
 * **The rule, which is the per-row shape criterion 3 asks to be settled here: the offer stands only where it
 * is true of every row the reason speaks for; the withdrawal is said only where it is true of every one of
 * them; and in between the line states the reason and stops.** Neither two-value rule is honest about a
 * mixed batch, and both fail in the same way the ticket was filed for — a sentence that is false for a row
 * on the same screen. Withdrawing on "any row unreachable" would tell staff that none of the links open,
 * so the patients whose links do open never get them; offering on "any row reachable" is the bug itself,
 * one import wider. What is left in the middle is the reason, which is true of all of them, and the remedy
 * stays where it is per row: **Copy intake** on the dashboard, and the row's own warning for the patients
 * it will not open for.
 *
 * The withdrawal is `NO_HANDOVER_SENTENCE` (lib/delivery.ts) word for word, singular and shared with the
 * three single-patient surfaces deliberately: one wording of one fact, and a batch-specific plural would be
 * a fifth copy of it for the next rewording to drift from, which is the argument every ticket in this family
 * rests on.
 *
 * Absent means `"all"`, the way `handover` is read as true when absent in lib/booking.ts and
 * lib/inviteNote.ts: it is a fact about the rows and the deployment rather than about the send, and a caller
 * without it is not made to guess.
 */
export function importInviteNote({
  fault,
  committed,
  handover = "all",
}: {
  fault: string;
  committed: boolean;
  handover?: BatchHandover;
}): string {
  const refusal = committed ? `No invites sent: ${fault}.` : `No invites will be sent: ${fault}.`;
  if (handover === "none") return `${refusal} ${NO_HANDOVER_SENTENCE}`;
  if (handover === "some") return refusal;
  if (committed) return `${refusal} Copy each link from the dashboard instead.`;
  return `${refusal} Create these visits and you will have to ${FALLBACK}.`;
}

// ---------------------------------------------------------------------------------------------
// The paragraph above all of it: what the dialog says a file is and what a row without a channel gets
// (§2.2, §8.1, T170).

/**
 * The import dialog's opening paragraph, in the pieces the dialog sets in `<code>`.
 *
 * It lived in the dialog as JSX, which is why it was the last line of this family left making the claim
 * T168 removed from `warningsFor` and T170 from `bookingPlan`: "a row with a blank `channel` is created
 * without an invite — hand those patients the link yourself, and opening it still sends them a code."
 * A general claim about every blank-`channel` row, and the preview directly below it warns, row by row,
 * about the ones with no number and no address — where there is nowhere to send that code at all. The same
 * frame held both (`desktop-provider-import-preview.png`).
 *
 * The clause is gone rather than qualified. Which rows can be sent a code is a fact about each row, the
 * preview already says it on the row it is true of (`warningsFor`, lib/visitIntake.ts), and an intro that
 * said it conditionally would be a second copy of that rule for the next rewording to drift from.
 *
 * T180 Which is why the *rest* of that sentence has now gone the same way. T170 trimmed the last clause and
 * left the one before it — "hand those patients the link yourself" — which is §8.1's fallback stated flatly
 * about every blank-`channel` row, and that is the same offer, one clause earlier. It is wrong on every
 * deployment including a fully configured one: a row with nothing on file reaches it in an office with both
 * senders, and the warning directly below it says that row's link will not open. So the offer goes for the
 * reason the code-promise went, in this paragraph's own words above: the remedy is per row, the intro has no
 * row to ask about — it is on screen before a file has been chosen — and the one place that does have the
 * answer is already saying it. What is left is what is true of every such row, and the whole of it: nothing
 * is sent.
 *
 * §8.1's fallback is not lost with it. It is `FALLBACK` above, on the tally line, which is told per import
 * whether it is a fallback at all (`handover`) — and it is **Copy intake** on every row of the dashboard,
 * which is where the link lives for every patient it opens for (§2.2).
 *
 * Here rather than in the dialog so the paragraph has a unit test (§12.1), like both tenses above it.
 */
export const IMPORT_INTRO = {
  /** The columns `parseVisitCsv` maps, as the dialog lists them. */
  columns: "name, phone, email, scheduled_at, visit_type, reason, channel, consent, consent_at",
  /** Up to the column name the sentence turns on. */
  before: "Every row is checked before anything is created, and a row with a blank",
  /** That column name, which the dialog renders in `<code>` like the list above. */
  column: "channel",
  /** And after it. */
  after: "is created without an invite.",
} as const;

/** The paragraph as a reader sees it, which is what `lib/importNote.test.ts` holds the rule to: the dialog
 *  renders these pieces in this order, so a clause cannot come back in one of them unexamined. */
export function importIntroText(): string {
  return `Columns: ${IMPORT_INTRO.columns}. ${IMPORT_INTRO.before} ${IMPORT_INTRO.column} ${IMPORT_INTRO.after}`;
}
