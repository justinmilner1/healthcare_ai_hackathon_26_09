// The standing caveat under a summary. `reviewedBy` is §7.3's sign-off: the clinician one-pager's own
// sentence says nobody has read it yet, which stops being true the moment somebody marks it reviewed.
export default function Disclaimer({
  audience,
  generatedAt,
  reviewedBy,
}: {
  audience: "provider" | "patient";
  generatedAt?: string | null;
  /** Who signed this summary off (§7.3), if anyone. Provider audience only. */
  reviewedBy?: string | null;
}) {
  const provider = reviewedBy
    ? `AI-generated from patient-uploaded data, reviewed by ${reviewedBy}. Verify with the patient; it flags, it does not diagnose.`
    : "AI-generated from patient-uploaded data. No clinician has reviewed this before you. Verify with the patient; it flags, it does not diagnose.";
  return (
    <p className="text-[11px] leading-snug text-[var(--viz-muted)]">
      {audience === "provider"
        ? provider
        : "A summary of your own data to help you and your doctor talk. It is not medical advice and does not change your treatment."}
      {generatedAt && <> Generated {new Date(generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</>}
    </p>
  );
}
