// The two-and-three-step progress strip at the top of §2.1's practice sign-up and §2.2's Add-patient
// wizard — one component, because it was the same markup in two files (T209, design §6.4).
//
// Both copies carried `aria-label` ("Setup progress", "Add patient progress") on a role-less `<div>`, which
// ARIA prohibits: the implicit role is `generic` and a generic element cannot be named, so neither label was
// ever announced (`lib/ariaName.ts` has the rule). An `<ol>` fixes it by being the thing it already was — a
// numbered list of steps, in order — and `list` is a role ARIA allows a name on. It is also what §2.5's own
// step strip is (`.sweetie-field-progress` in app/s/[token]/page.tsx, `<ol aria-label="Intake steps">` with
// `aria-current="step"`), so the product now says "a strip of steps" the same way in all three places.
//
// One component rather than two edits is the point: the bug was that the same markup existed twice and the
// label was wrong in both, so a fix in two files is a fix that can drift back apart.

/**
 * `labels` are the step names in order, `step` is the index of the one being asked about, and `label` names
 * the strip as a whole.
 *
 * Steps before `step` are done; the one at `step` is current and carries `aria-current="step"`, which is how
 * a screen-reader user hears which of the three they are on — the tick and the circled number say it to the
 * eye and nothing said it to them. `<em>` holds the step's own name so the phone stylesheet can take it out
 * of the flow without taking it away from a screen reader, the same arrangement §2.5's strip uses.
 */
export default function Stepper({
  label,
  labels,
  step,
}: {
  label: string;
  labels: readonly string[];
  step: number;
}) {
  return (
    <ol className="ss-stepper" aria-label={label}>
      {labels.map((name, index) => (
        <li
          key={name}
          className={`ss-step ${index === step ? "ss-step-active" : ""} ${index < step ? "ss-step-done" : ""}`}
          aria-current={index === step ? "step" : undefined}
        >
          <span>{index < step ? "✓" : index + 1}</span>
          <em>{name}</em>
        </li>
      ))}
    </ol>
  );
}
