export default function Disclaimer({ audience, generatedAt }: { audience: "provider" | "patient"; generatedAt?: string | null }) {
  return (
    <p className="text-[11px] leading-snug text-[var(--viz-muted)]">
      {audience === "provider"
        ? "AI-generated from patient-uploaded data. No clinician has reviewed this before you. Verify with the patient; it flags, it does not diagnose."
        : "A summary of your own data to help you and your doctor talk. It is not medical advice and does not change your treatment."}
      {generatedAt && <> Generated {new Date(generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</>}
    </p>
  );
}
