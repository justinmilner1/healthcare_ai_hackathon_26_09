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

/** §8.1's fallback on this screen is a button on every imported row — **Copy intake** — so both tenses
 *  point at it. Named once, because the two sentences differ in when the trip has to be made and not in
 *  where it goes. */
const FALLBACK = "copy each link from the dashboard";

/**
 * The line under the import tally for one of `inviteFaults`' reasons (lib/notify.ts).
 *
 * `committed` is the whole branch, and it is a tense and not a different fact: the preview is a forecast
 * staff can still act on by closing the dialog, and the result is a report on rows that exist. So the
 * forecast names the press it is a forecast about — the cost of pressing the button is what the preview was
 * missing — and the report keeps T111's sentence word for word, because it was right.
 */
export function importInviteNote({ fault, committed }: { fault: string; committed: boolean }): string {
  if (committed) return `No invites sent: ${fault}. Copy each link from the dashboard instead.`;
  return `No invites will be sent: ${fault}. Create these visits and you will have to ${FALLBACK}.`;
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
 * said it conditionally would be a second copy of that rule for the next rewording to drift from. What is
 * left is what is true of every such row: nothing is sent, and the link is staff's to hand over — §8.1's
 * fallback, which is what `FALLBACK` points at one tense at a time above.
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
  after: "is created without an invite — hand those patients the link yourself.",
} as const;

/** The paragraph as a reader sees it, which is what `lib/importNote.test.ts` holds the rule to: the dialog
 *  renders these pieces in this order, so a clause cannot come back in one of them unexamined. */
export function importIntroText(): string {
  return `Columns: ${IMPORT_INTRO.columns}. ${IMPORT_INTRO.before} ${IMPORT_INTRO.column} ${IMPORT_INTRO.after}`;
}
