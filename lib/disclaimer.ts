// The standing caveat under a clinician's summary, and what it is allowed to claim (design §2.6, §7.3,
// §7.4). Owner: sour.
//
// One sentence, in the footer of both of the clinician's surfaces — the brief (app/provider/[id]/sour.tsx)
// and the printed one-pager (app/provider/visit/[id]/print/page.tsx) — rendered by components/Disclaimer.tsx
// for both. It is the one line on the page whose whole job is to say what the reader is holding and how far
// to trust it, and it was a pair of literals that opened by asserting two things:
//
//   AI-generated from patient-uploaded data. No clinician has reviewed this before you. …
//
// Both footers sit outside every branch, so that went onto two pages where neither half was true. On a
// visit nobody has started (`visitNotStarted`, lib/sourState.ts) the brief says three times over that there
// is nothing here — "Waiting on the patient", "Nothing to summarize until the patient has talked to
// Sweetie", every row of the checklist unticked — and then signed off claiming the page above it was
// generated from data the patient uploaded. `bundle.providerSummaryAt` is null there, which is why the
// sentence did not even carry its own "Generated …" clause. The printed sheet is the worse of the two: §7.4's
// one-pager goes into a chart, and it read "Nothing to summarize yet / The patient has not talked to Sweetie
// or shared any data for this visit" over the same claim. And on a check-in with no exports (T143) the brief
// carried its own notice — "No glucose data was shared. This summary is from the conversation only." — one
// line above a caveat naming uploads as the source: the page named the provenance correctly in the notice
// and misnamed it in the caveat.
//
// That is the ninth time this repo has had to stop a screen claiming something the data or the deployment
// does not support (T91, T94, T110, T111, T120, T122, T129, T168, T170), and the first on the clinician's
// side of the handover.
//
// So the wording is a function of the visit's own facts rather than a string in a component, the way
// lib/spikePlaces.ts owns the chart caption and the spike card heading for the same two surfaces (T157,
// T165) and lib/teamInvite.ts owns the invite card's pair (T131). And, as there, the invariant is checked as
// data rather than as prose: every line says whether it claims a generated summary, whether it names an
// upload as the source, and whether it names §7.3's reviewer, and lib/disclaimer.test.ts holds those to the
// facts. A later reword cannot put the claim back.
//
// Pure — no Prisma, no React — because the brief is a client component and the sheet is server-rendered, and
// the two have to read the same.

import type { IntakeStatus } from "./types";

/** The half that is true of every state and is the reason the sentence exists at all (§2.6). */
const FLAGS_NOT_DIAGNOSE = "it flags, it does not diagnose";

/**
 * Did the patient share an export at all? (§2.5's optional data panel: Dexcom, Timeline or WHOOP.)
 *
 * All three, not `hasDexcom` alone: "uploaded data" is a claim about the patient having uploaded something,
 * and a Timeline or a WHOOP export is something. The brief's own no-glucose notice is a narrower statement
 * about the numbers and is left as it is.
 */
export const sharedAnyExport = (status: Pick<IntakeStatus, "hasDexcom" | "hasLocation" | "hasWhoop">): boolean =>
  status.hasDexcom || status.hasLocation || status.hasWhoop;

/** What the clinician's footer is being asked about. */
export type ClinicianCaveatFacts = {
  /** A summary exists for this visit — `bundle.providerSummaryAt` is not null. */
  generated: boolean;
  /** The patient shared at least one export (`sharedAnyExport` of `bundle.status`). */
  uploads: boolean;
  /** Who signed this visit off (§7.3), if anyone. */
  reviewedBy?: string | null;
};

/** One footer sentence, and what it claims — which is the part the test holds to the facts. */
export type ClinicianCaveat = {
  /** The sentence itself, as both surfaces show it. */
  text: string;
  /** Whether it tells the clinician that what is above it was written by the model. */
  claimsGenerated: boolean;
  /** Whether it names something the patient uploaded as where that came from. */
  claimsUploads: boolean;
  /** Whether it names §7.3's reviewer. */
  namesReviewer: boolean;
  /** Whether it still says the thing worth saying on every page: verify it, and it does not diagnose. */
  warnsVerify: boolean;
};

/**
 * The footer sentence for a clinician, from the visit's own facts (§2.6, §7.3, §7.4).
 *
 * Three readings of the provenance, and §7.3's sign-off crossed with each:
 *
 * | the visit | what the sentence says it is |
 * |---|---|
 * | a summary, and the patient shared an export | AI-generated from patient-uploaded data |
 * | a summary, and no export — the §2.5 check-in only | AI-generated from the patient's own answers |
 * | no summary | nothing has been generated yet |
 *
 * The first row is the ordinary state and is word for word what it was.
 *
 * `generated` is the saved summary and not `visitNotStarted`, because the states between the two are wrong
 * in the same way: a patient two answers in with no run yet has a brief reading "No summary yet." over the
 * old claim as well. A reviewer with no summary is reachable — the Dexcom OAuth callback deletes the saved
 * pair while the fresh run is in flight (lib/sourQueue.ts) and `Visit.reviewedAt` outlives it (lib/review.ts)
 * — so that branch says whose sign-off it is and that the summary it was given to is gone, rather than
 * crediting a reviewer with a page that is empty.
 */
export function clinicianCaveat({ generated, uploads, reviewedBy }: ClinicianCaveatFacts): ClinicianCaveat {
  const namesReviewer = Boolean(reviewedBy);
  if (!generated) {
    const signOff = reviewedBy ? ` — ${reviewedBy}'s sign-off is from a summary this visit no longer has` : "";
    return {
      text: `Nothing has been generated for this visit yet${signOff}. Whatever Sour writes here will be yours to verify with the patient; ${FLAGS_NOT_DIAGNOSE}.`,
      claimsGenerated: false,
      claimsUploads: false,
      namesReviewer,
      warnsVerify: true,
    };
  }
  const source = uploads ? "patient-uploaded data" : "the patient's own answers";
  return {
    text: reviewedBy
      ? `AI-generated from ${source}, reviewed by ${reviewedBy}. Verify with the patient; ${FLAGS_NOT_DIAGNOSE}.`
      : `AI-generated from ${source}. No clinician has reviewed this before you. Verify with the patient; ${FLAGS_NOT_DIAGNOSE}.`,
    claimsGenerated: true,
    claimsUploads: uploads,
    namesReviewer,
    warnsVerify: true,
  };
}
