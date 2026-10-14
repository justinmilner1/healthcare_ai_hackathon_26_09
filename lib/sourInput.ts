// The fingerprint of everything a Sour summary is made from (design §7.1). Owner: back end.
//
// §7.1 asks for Sour to be idempotent "per visit and input hash": a second run over unchanged inputs returns
// the summary that is already saved instead of spending two more model calls on the same week. This module is
// the hash half of that — pure, no database, no model — so the rule is one testable function rather than a
// comparison smeared across lib/sourRun.ts and lib/bundle.ts. The lookup half is `existingSummaryFor` in
// lib/sourRun.ts, and the stored fingerprint is `Summary.inputHash`.
//
// What goes in: everything that can change what Sour writes.
//   - the structured intake and the notes rendered from it (what the patient said)
//   - the visit type and the reason for the visit, which shape the brief and the intake template
//   - every upload, by id and row count: a re-uploaded Dexcom export is a new Upload row, so a new id is
//     exactly "the data changed", and parsedRows catches a re-parse of the same row
//   - where the narrative came from, see below
//
// What stays out: anything derived from the above (the spikes, the stats, the brief), and the model id, which
// is operations rather than input — a practice that moves to a newer model gets the newer narrative on the
// next real change, not a silent re-run of every saved summary.

import { createHash } from "node:crypto";

/**
 * Where a saved summary's patterns and questions came from.
 *
 * Part of the fingerprint because the two are not interchangeable. With no `OPENAI_API_KEY` configured at all,
 * Sour writes a deterministic placeholder ("LLM not configured…"); that is a complete answer for that
 * deployment and reusing it is right. The moment a key is configured the same inputs deserve a real
 * narrative, and because the source is in the hash, that run finds no match and really runs.
 *
 * The third case — a key is configured but the gateway is down — has no value here: lib/sourRun.ts stores a
 * null `inputHash` for it, so the placeholder it writes is never reused and the retry really retries.
 */
export type NarrativeSource = "model" | "unconfigured";

export const narrativeSource = (configured: boolean): NarrativeSource => (configured ? "model" : "unconfigured");

/** One upload, as the fingerprint sees it. */
export type SourUploadRef = { id: string; kind: string; parsedRows: number };

export type SourInputs = {
  /** `Visit.intake`: the structured IntakeState as JSON, or null before the patient has said anything. */
  intake: string | null;
  /** `Visit.notes`: the same answers rendered for Sour to read. */
  notes: string | null;
  visitType: string | null;
  reason: string | null;
  uploads: SourUploadRef[];
  source: NarrativeSource;
};

/** Bump when the canonical form below changes shape, so old fingerprints stop matching instead of matching
 *  something they do not describe. */
const HASH_VERSION = 1;

/** The fingerprint of one set of inputs: the same inputs always give the same string, and any change to any
 *  of them gives a different one. Hex sha-256, so it is safe in a URL, a log line and a database column. */
export function sourInputHash(inputs: SourInputs): string {
  const uploads = inputs.uploads
    .map((u) => [u.kind, u.id, u.parsedRows] as const)
    // Uploads come back from the database in whatever order the query asked for; sorting makes the
    // fingerprint about the set of files, not about the ordering of one query.
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
  const canonical = JSON.stringify({
    v: HASH_VERSION,
    source: inputs.source,
    visitType: inputs.visitType ?? null,
    reason: inputs.reason ?? null,
    // The intake is JSON written by Sweetie; re-serialized with sorted keys so that a turn which refills the
    // same answers in a different key order is not mistaken for new information.
    intake: stableJson(inputs.intake),
    notes: inputs.notes ?? null,
    uploads,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The inputs of one visit. Takes the visit columns rather than the row, so both the summary runner and the
 *  bundle can call it without agreeing on which relations were included. */
export function sourInputsFor(
  visit: { intake: string | null; notes: string | null; visitType: string | null; reason: string | null },
  uploads: SourUploadRef[],
  source: NarrativeSource,
): SourInputs {
  return { intake: visit.intake, notes: visit.notes, visitType: visit.visitType, reason: visit.reason, uploads, source };
}

/** Parsed and re-serialized with every object's keys in order, so the text is about the content. Unparseable
 *  text is hashed as it stands: it is still a difference worth noticing, just not one we can normalize. */
function stableJson(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
