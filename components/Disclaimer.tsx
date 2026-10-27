// The standing caveat under a summary. The clinician's half of it is a function of the visit's own facts
// (lib/disclaimer.ts, T171, T174): what it may claim about the provenance depends on whether there is a
// summary at all, on whether the patient shared an export, and on whether the model wrote the narrative, and
// §7.3's `reviewedBy` is the sign-off. Both of the clinician's surfaces render this component, so the brief
// and the printed one-pager cannot disagree.
//
// `narrativeMissing` is the summary's own (`bundle.providerSummary`), which is where the degraded note and
// the two "Not generated." lists on both surfaces already read theirs from (lib/sourState.ts `narrativeNote`,
// `emptyNarrativeText`) — so the footer cannot say the model wrote a page those three say it did not.
import { clinicianCaveat, sharedAnyExport } from "@/lib/disclaimer";
import type { IntakeStatus, NarrativeMissing } from "@/lib/types";

export default function Disclaimer({
  audience,
  generatedAt,
  reviewedBy,
  status,
  narrativeMissing,
}: {
  audience: "provider" | "patient";
  generatedAt?: string | null;
  /** Who signed this summary off (§7.3), if anyone. Provider audience only. */
  reviewedBy?: string | null;
  /** What the patient shared (`bundle.status`), which is the source the sentence may name. Provider only. */
  status?: Pick<IntakeStatus, "hasDexcom" | "hasLocation" | "hasWhoop">;
  /** Why this summary has no patterns and no questions (§6.3), if that is the state. Provider only. */
  narrativeMissing?: NarrativeMissing;
}) {
  const provider = clinicianCaveat({
    generated: Boolean(generatedAt),
    uploads: status ? sharedAnyExport(status) : false,
    narrativeWritten: !narrativeMissing,
    reviewedBy,
  }).text;
  return (
    <p className="text-[11px] leading-snug text-[var(--viz-muted)]">
      {audience === "provider"
        ? provider
        : "A summary of your own data to help you and your doctor talk. It is not medical advice and does not change your treatment."}
      {generatedAt && <> Generated {new Date(generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</>}
    </p>
  );
}
