// The visit-type table and the three ways the app says a visit type out loud. Pure data and pure functions,
// in their own module because the provider pages are client components: importing them from lib/sweetie.ts
// dragged the whole model client into the browser bundle, and once lib/llm.ts started logging (node:async_hooks,
// node:crypto) that stopped building at all. Nothing here touches the model, the database, or the request.

export const VISIT_TYPES: { id: string; label: string }[] = [
  { id: "follow_up", label: "Follow-up" },
  { id: "new_patient", label: "New patient" },
  { id: "medication", label: "Medication check" },
  { id: "post_hospital", label: "After a hospital or ER visit" },
  { id: "annual", label: "Annual review" },
];

export const visitLabel = (id: string | null | undefined) => VISIT_TYPES.find((v) => v.id === id)?.label ?? "Visit";

/** The visit type if it is one of ours, else "other". Booking accepts the field as free text, so anything
 *  that leaves the app — a log line above all — goes through here first (design §10.3). */
export const knownVisitType = (id: string | null | undefined) => (VISIT_TYPES.some((v) => v.id === id) ? (id as string) : "other");

/** How Sweetie refers to the visit in a sentence: "your first visit", "your medication check". */
export const visitPhrase = (id: string | null | undefined) =>
  ({ follow_up: "follow-up visit", new_patient: "first visit", medication: "medication check", post_hospital: "visit after the hospital", annual: "annual review" } as Record<string, string>)[id ?? ""] ?? "visit";

// ---------------------------------------------------------------------------------------------
// The visit lifecycle (design §4.4). `Visit.status` is the one answer to "where is this visit", and the
// dashboard prints it rather than guessing from uploads and answer counts the way the hackathon screen did.
// Order is the order a visit moves through; `cancelled` sits outside it.

export const VISIT_STATUSES = [
  { id: "invited", label: "Invited", tone: "invited" },
  { id: "verified", label: "Link opened", tone: "uploading" },
  { id: "in_intake", label: "Talking to Sweetie", tone: "chatting" },
  { id: "intake_done", label: "Intake finished", tone: "finished" },
  { id: "summary_ready", label: "Summary ready", tone: "ready" },
  { id: "reviewed", label: "Reviewed", tone: "ready" },
  { id: "cancelled", label: "Cancelled", tone: "cancelled" },
] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number]["id"];

const statusRow = (id: string | null | undefined) => VISIT_STATUSES.find((s) => s.id === id);

/** §4.4's status in the words the dashboard uses. An unknown value is shown as stored, not hidden: a row
 *  written by a newer build should read oddly rather than silently as "Invited". */
export const visitStatusLabel = (id: string | null | undefined) => statusRow(id)?.label ?? String(id ?? "Unknown");

/** Which `.provider-stage-*` class the pill wears. Unknown statuses get the neutral one. */
export const visitStatusTone = (id: string | null | undefined) => statusRow(id)?.tone ?? "invited";
