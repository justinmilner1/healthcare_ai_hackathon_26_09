// The sentence under the Dexcom card in the patient's data panel (design §2.5, §9.2). Owner: sweetie.
//
// The card has two independent things going on: what the patient has already shared with this visit, and
// what — if anything — they can connect. The hint used to answer only the second, and to answer it with a
// fact about the deployment: a visit with no Dexcom credentials printed "Dexcom connection is not
// configured yet. CSV upload is still available outside demo mode." above a card that said CONNECTED with
// the patient's record count on it (T71). A patient reads §2.5's panel, so the hint says what they have
// shared and what they can do, in their words, and never what an operator has or has not set.
//
// The same argument decides which control the card offers, which is why `dexcomConnectControl` is here
// beside the sentence (T91): a deployment with no credentials cannot connect anything, so the card offered
// the patient a greyed-out Connect Dexcom button with nothing saying why — the operator fact T71 took out
// of the hint, put back as a dead control. A patient is offered what works and nothing else.
//
// Pure, and in lib/ rather than in the page, so every state can be held to that in a unit test (§12.1).

import type { DexcomEnv } from "./dexcomEnv";

export type DexcomHint = {
  /** Which Dexcom this deployment talks to — decides which demonstration there is to describe (§9.2). */
  env: DexcomEnv;
  /** Whether an operator has given this deployment Dexcom credentials. Never said to the patient. */
  configured: boolean;
  /** Whether this visit is the kind that may connect at all (`lib/dexcom.ts` visitMatchesEnv). */
  canConnect: boolean;
  /** A synthetic demonstration visit (§13.4): its readings are invented and its uploads are disabled. */
  sandboxPatient: boolean;
  /** Whether an OAuth import of this visit's own exists. */
  imported: boolean;
  /** That import's date range, already formatted for the reader, when it has one. */
  importRange: string | null;
  /** Whether a Dexcom file of the patient's is in this visit — the CSV path, which needs no credentials. */
  uploaded: boolean;
};

const AUTHORIZE = "Authorize on Dexcom and return here.";

// The demonstration the sandbox offers a real visit instead of that authorization (§9.2, §13.4) is
// described on three surfaces: under the Dexcom card before and after an upload, and in §2.7's empty
// state. One claim made three times is one phrase written once, so a reword of it is a reword of all
// three and none of them can drift from the destination (T118's rule for `"none"`, T125's for `"demo"`).
const DEMO_SESSION = "a separate synthetic-data session";
const DEMO_UNCHANGED = "Your existing uploads stay unchanged.";

/** What the patient can do next once their file is in. Never the reason a connection is missing. */
function nextStep({ env, configured, canConnect }: DexcomHint): string {
  if (configured && canConnect) return "You can also connect Dexcom to import your readings automatically.";
  if (configured && env === "sandbox") return `Connecting the demo opens ${DEMO_SESSION} and leaves your file unchanged.`;
  return "Upload a newer export any time to replace it.";
}

/** The one sentence under the Dexcom card, for whichever state this visit is in. */
export function dexcomCardHint(hint: DexcomHint): string {
  // What the patient has shared comes first. A card headed CONNECTED, with a record count on it, cannot
  // carry a hint written for a visit with nothing in it (T71).
  if (hint.imported) {
    if (hint.importRange) return hint.sandboxPatient ? `${hint.importRange} · Synthetic readings` : hint.importRange;
    return hint.sandboxPatient ? "Your synthetic Dexcom readings are in." : "Your Dexcom readings are in.";
  }
  if (hint.uploaded) return `Your Clarity CSV is in. ${nextStep(hint)}`;
  // Nothing shared yet. With no credentials there is nothing to connect — demonstration included — so the
  // only thing to tell the patient is the path that works, which is their own export.
  // No span: this sentence is about a file the *patient* chooses, and Clarity exports whatever range they
  // pick. `parseClarityCsv` (lib/glucose.ts) keeps every EGV row it is handed, and
  // data/fixtures/clarity_window.csv — 84 readings inside one morning — is a supported upload this line
  // described wrongly as seven days (T132). It is the presumption T123 took out of `summaryDataInvite`
  // below, which is why both now say "your readings" and read the same whether one day or seven arrives.
  if (!hint.configured) return "Upload your Clarity CSV export to share your glucose readings.";
  if (!hint.canConnect) {
    // Nothing for this visit to connect to (§9.2): on the sandbox a real patient is offered the separate
    // demonstration instead, and in production a demo visit has nothing to be offered at all.
    return hint.env === "sandbox"
      ? `Demo connects ${DEMO_SESSION}. ${DEMO_UNCHANGED}`
      : "This demonstration visit cannot connect to a real Dexcom account.";
  }
  // The one legitimate span in this module, and it stays (T132). Every other "7 days" on the patient path
  // was a guess about a file the patient picks; this one is a fact about what the *connection* fetches —
  // lib/dexcom.ts requests `{ start: Math.max(first, end - 7 * 86400000), end }`, pinned by
  // lib/dexcom.test.ts. That is the rule itself: name a span the system controls, never one the patient
  // chooses. A sweep of this shape should leave this line alone; the span test below excludes this branch
  // by name rather than by a pattern that happens to miss it.
  return hint.sandboxPatient
    ? `${AUTHORIZE} Only synthetic readings are imported.`
    : `${AUTHORIZE} Your last 7 days of readings are imported.`;
}

/** Which connect control, if any, the Dexcom card puts in front of this patient. */
export type DexcomConnectControl =
  /** The OAuth button: this visit may connect to the Dexcom this deployment talks to. */
  | "oauth"
  /** The link to a separate synthetic demonstration, which is all the sandbox has for a real visit. */
  | "demo"
  /** Nothing to offer. The card's upload is then the only way in, and the hint above says so. */
  | "none";

/**
 * The one control the Dexcom card renders, for whichever state this visit is in (§2.5, §9.2).
 *
 * `"none"` means render nothing — not a disabled button. The page used to decide this the other way round:
 * it chose a control from `canConnect` and the environment and then disabled it when `configured` was
 * false, so the default offline deployment (the README's, the check script's, the demo's) put a dead
 * **Connect Dexcom · Demo** at the top of the panel on every single run (T91).
 */
export function dexcomConnectControl(
  { env, configured, canConnect, sandboxPatient }: Pick<DexcomHint, "env" | "configured" | "canConnect" | "sandboxPatient">,
): DexcomConnectControl {
  // No credentials, nothing to connect — the demonstration included, since the sandbox needs the same
  // client as production does (lib/dexcom.ts dexcomConfig).
  if (!configured) return "none";
  if (canConnect) return "oauth";
  // A real visit on a sandbox deployment: its own readings are not on offer, a synthetic session is (§13.4).
  if (env === "sandbox" && !sandboxPatient) return "demo";
  // A demonstration visit on a production deployment has nothing to connect to at all.
  return "none";
}

/**
 * What §2.7's empty state puts in front of a patient who has shared no glucose yet.
 *
 * The summary page's invitation and the data panel's control are one promise made twice, so they are
 * decided by one function rather than two: the button on `/patient/<token>` is a link to `/s/<token>`, and
 * what it names has to be something that page will actually offer when the patient arrives (T118).
 */
export type SummaryDataInvite = {
  /** The sentence under the heading, in the patient's words. Never a fact about the deployment. */
  body: string;
  /** The button's words, or null where the destination has no Dexcom control to send the patient to. */
  action: string | null;
};

/**
 * The invitation on the patient's own summary while it has no readings in it (§2.5, §2.7).
 *
 * `control` is what `dexcomConnectControl` has already decided for this visit, so the two surfaces cannot
 * drift: where there is no connection to offer, this page stops offering one. It used to offer **Connect
 * Dexcom** on the strength of `hasDexcom` alone, which on the default offline deployment — the README's,
 * the check script's and the demo's — sent the patient to a page with no Dexcom control anywhere on it and
 * left them to work out that "Upload CSV" was what had been meant (T118).
 *
 * All three controls are branched on, not two. T118 split `"none"` off and left the other two together on
 * `control !== "none"`, but `"oauth"` and `"demo"` are not the same offer (T125): the first imports this
 * patient's own readings, the second opens somebody's synthetic ones in a session of its own. A real
 * patient on a sandbox deployment — which is every patient on §13.4's sandbox — therefore read "Connect
 * your Dexcom export and Sweetie will turn your readings into a clear picture", pressed it, and got the
 * demonstration whose own hint on the destination says the opposite. That is T118's defect one state over,
 * in the costlier direction: a promise about *their* data, made on the one page §2.7 writes for them.
 *
 * The file upload is the fallback because it needs no credentials, but it is not universal: `/s/<token>`
 * renders its uploads for a real visit only (§13.4), so a synthetic demonstration visit with nothing to
 * connect has nothing to be sent for either, and gets a card with no button rather than a dead one (T91).
 *
 * No branch names a span. This is the one state of the summary where there is no data to take one from,
 * and the page around it is held to that: a patient who has shared nothing is told what sharing does, not
 * how much of it to expect (§2.5, T123). "the past week" here presumed the upload would be a week, which
 * is the thing T100 and T114 established this page must not do — the sentence says "your readings" on
 * every branch instead, and reads the same whether one day or seven arrives afterwards.
 */
export function summaryDataInvite(
  { control, sandboxPatient }: { control: DexcomConnectControl; sandboxPatient: boolean },
): SummaryDataInvite {
  // The real OAuth button, which imports the readings of whoever this visit belongs to.
  if (control === "oauth") {
    return {
      body: sandboxPatient
        ? "Connect Dexcom sandbox in Sweetie to import synthetic demo readings."
        : "Connect your Dexcom export and Sweetie will turn your readings into a clear picture for you and your doctor.",
      action: "Connect Dexcom",
    };
  }
  // The demonstration, which is not that button: it opens a session of its own and brings this visit
  // nothing. So the sentence makes the destination's own promise (DEMO_UNCHANGED, DEMO_SESSION) rather
  // than the one above it, and the button names the demonstration instead of a connection — "Connect
  // Dexcom" is a claim about this patient's readings and there are none coming.
  //
  // `sandboxPatient` is not read here. It cannot be true in this branch — `dexcomConnectControl` returns
  // `"demo"` only for a real visit — and the copy would not want it if it could: what this state turns on
  // is where the button leads, not whose record it was pressed from. The destination's own control is
  // labelled "Try Dexcom sandbox"; this says "demo" because the patient reading it is a real patient, who
  // is never told which Dexcom an operator pointed the deployment at (the T71 rule).
  if (control === "demo") {
    return {
      body: `The Dexcom demo in Sweetie opens ${DEMO_SESSION} — synthetic readings, not your own. ${DEMO_UNCHANGED}`,
      action: "Try the Dexcom demo",
    };
  }
  // Nothing to connect. A real visit can still share the export it already has, which is the one path into
  // this page that never needed a connection at all.
  if (!sandboxPatient) {
    return {
      body: "Share your Dexcom export in Sweetie and it will turn your readings into a clear picture for you and your doctor.",
      action: "Upload your Dexcom export",
    };
  }
  // A synthetic demonstration visit whose readings are not on offer: its uploads are disabled too, so there
  // is no second path to point at.
  return { body: "This demonstration visit has no synthetic readings in it.", action: null };
}
