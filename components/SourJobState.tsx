// The summary job's state on the provider page, with the retry §7.2 asks for. Owner: front end.
//
// The wording and the precedence are lib/sourState.ts; this is the chip around them. It is a live region so a
// clinician using a screen reader hears "Queued" become "Running" become "Ready" without re-reading the page.

import { summaryState, type SummaryStateInput } from "@/lib/sourState";

export type SourJobStateProps = SummaryStateInput & {
  /** Re-enqueues the `sour.run` job. Only ever rendered for a failed job. */
  onRetry: () => void;
  /** True while this page is waiting on a run it started, so the retry cannot be double-clicked. */
  pending: boolean;
};

export default function SourJobState({ onRetry, pending, ...input }: SourJobStateProps) {
  const state = summaryState(input);
  return (
    <div className="sour-job-state print:hidden" data-phase={state.phase} role="status" aria-live="polite">
      <span className="sour-job-chip">{state.label}</span>
      <p className="sour-job-detail">
        <span className="sour-job-label">Summary</span>
        {state.detail}
        {state.at && <time dateTime={state.at}> {formatAt(state.at)}</time>}
      </p>
      {state.canRetry && (
        <button type="button" onClick={onRetry} disabled={pending} className="ss-button sour-job-retry print:hidden">
          {pending ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}

/** Today's times read as times; anything older needs the date to mean anything. */
function formatAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
