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

/** What the patient can do next once their file is in. Never the reason a connection is missing. */
function nextStep({ env, configured, canConnect }: DexcomHint): string {
  if (configured && canConnect) return "You can also connect Dexcom to import your readings automatically.";
  if (configured && env === "sandbox") return "Connecting the demo opens a separate synthetic-data session and leaves your file unchanged.";
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
  if (!hint.configured) return "Upload your Clarity CSV export to share your last 7 days of glucose.";
  if (!hint.canConnect) {
    // Nothing for this visit to connect to (§9.2): on the sandbox a real patient is offered the separate
    // demonstration instead, and in production a demo visit has nothing to be offered at all.
    return hint.env === "sandbox"
      ? "Demo connects a separate synthetic-data session. Your existing uploads stay unchanged."
      : "This demonstration visit cannot connect to a real Dexcom account.";
  }
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
