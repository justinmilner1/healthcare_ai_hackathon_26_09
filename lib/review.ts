// Marking a summary reviewed (design §2.6, §7.3). Owner: Justin (Sour).
//
// §7.3 is one sentence: "a button records reviewer and time, moves the visit to `reviewed`, and shows in the
// dashboard." The record lives in two places on purpose, both named by §4: `Visit.reviewedBy` and
// `Visit.reviewedAt` (§4.4), which is what the dashboard reads for a list of visits in one query, and the
// same pair on `Summary` (§4.7), which is what keeps the sign-off attached to the thing that was signed off
// if the visit is later re-summarized.
//
// Three rules, all of them about not rewriting history:
//
//   * The first sign-off wins. A second press — a reload, two clinicians on the same patient — returns the
//     stored reviewer and time rather than replacing them. "Who read this before the visit" has one answer.
//   * Nothing is reviewed before there is something to review. A visit with no summary is refused, so the
//     status cannot jump to `reviewed` ahead of the one-pager it is a statement about.
//   * A cancelled visit (§4.4 puts it outside the lifecycle) is refused too.
//
// The write is one `updateMany` with the whole rule in its `where`, so two clinicians pressing the button at
// the same moment cannot both win: the loser's update matches no row and it re-reads the sign-off that stood.
//
// No next/* imports and the client is a parameter, so lib/review.test.ts can drive the real write through a
// throwaway schema (the same split as lib/consent.ts).

import type { PrismaClient } from "@prisma/client";
import { db } from "./db";
import type { ReviewRecord } from "./types";

/** Only the part of the client this module uses, so a test can pass one pointed at a fixture schema. */
export type ReviewClient = Pick<PrismaClient, "visit" | "summary" | "user">;

/** The clinician doing the signing off: the session's own user (lib/auth.ts ProviderUser). */
export type Reviewer = { id: string; name: string | null; email: string };

/** How a reviewer is shown once their name is joined back on. A user who has since left the practice is
 *  named the way the audit page names them, for the same reason: the record outlives the account. */
export const FORMER_COLLEAGUE = "Former colleague";

export const reviewerLabel = (user: { name?: string | null; email?: string | null } | null | undefined): string =>
  user?.name?.trim() || user?.email?.trim() || FORMER_COLLEAGUE;

/** The statuses a sign-off may move a visit out of: every stage of §4.4's lifecycle except `reviewed`, which
 *  is where it is going, and `cancelled`, which is not on the way there. */
export const REVIEWABLE_FROM = ["invited", "verified", "in_intake", "intake_done", "summary_ready"] as const;

/** Why a sign-off was refused. Both are states the button is not offered in, so they are races and direct
 *  calls rather than anything a clinician can walk into by clicking. */
export type ReviewRefusal = "no_summary" | "cancelled";

export type ReviewOutcome =
  | { ok: true; record: ReviewRecord; already: boolean }
  | { ok: false; reason: ReviewRefusal };

/** What the page says when a sign-off is refused. Plain, and about this visit rather than about the API. */
export const REFUSAL_MESSAGES: Record<ReviewRefusal, string> = {
  no_summary: "There is no summary to review yet. Generate one first.",
  cancelled: "This visit was cancelled, so it cannot be marked reviewed.",
};

/**
 * Record the sign-off (§7.3). The visit comes from the route's guard, already checked to be one of the
 * caller's practice's (lib/guard.ts), so this is only ever the write and the rules around it.
 *
 * `already: true` means someone had signed it off first — including this same clinician a moment ago — and
 * the record returned is theirs.
 */
export async function markReviewed(
  visit: { id: string; status: string },
  reviewer: Reviewer,
  now: Date = new Date(),
  client: ReviewClient = db,
): Promise<ReviewOutcome> {
  const summaries = await client.summary.count({ where: { visitId: visit.id } });
  if (!summaries) return { ok: false, reason: "no_summary" };

  const stamped = await client.visit.updateMany({
    where: { id: visit.id, reviewedAt: null, status: { in: [...REVIEWABLE_FROM] } },
    data: { reviewedBy: reviewer.id, reviewedAt: now, status: "reviewed" },
  });
  if (stamped.count === 1) {
    // §4.7: the same pair on the summaries the sign-off covers. Both audiences, because Sour writes them as
    // a pair from one run and the patient's version is written from the clinician's (lib/sourRun.ts), so a
    // sign-off that stamped only the one-pager would leave the other looking unreviewed.
    await client.summary.updateMany({ where: { visitId: visit.id }, data: { reviewedBy: reviewer.id, reviewedAt: now } });
    return { ok: true, already: false, record: { at: now.toISOString(), by: reviewer.id, byName: reviewerLabel(reviewer) } };
  }

  // The update matched nothing: either it was signed off already, or the visit is not in a state a sign-off
  // can move. Re-read rather than guess, and hand back whoever really holds it.
  const fresh = await client.visit.findUnique({ where: { id: visit.id }, select: { reviewedBy: true, reviewedAt: true } });
  const record = await reviewRecord(fresh, client);
  if (record) return { ok: true, already: true, record };
  return { ok: false, reason: "cancelled" };
}

/**
 * The sign-off as the pages read it, or null for a visit nobody has signed off. The reviewer's name is
 * joined here and never stored beside the id, the same way the audit page joins its actors.
 */
export async function reviewRecord(
  visit: { reviewedBy: string | null; reviewedAt: Date | null } | null | undefined,
  client: ReviewClient = db,
): Promise<ReviewRecord | null> {
  if (!visit?.reviewedAt) return null;
  const user = visit.reviewedBy ? await client.user.findUnique({ where: { id: visit.reviewedBy }, select: { name: true, email: true } }) : null;
  return { at: visit.reviewedAt.toISOString(), by: visit.reviewedBy, byName: reviewerLabel(user) };
}

/**
 * The reviewers of a list of visits, by user id, in one query — what the dashboard needs, where asking per
 * row would be a query per visit (the same shape as deliveriesByVisit in lib/visitStore.ts).
 */
export async function reviewerNames(ids: (string | null)[], client: ReviewClient = db): Promise<Record<string, string>> {
  const wanted = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (!wanted.length) return {};
  const users = await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, email: true } });
  const byId: Record<string, string> = {};
  for (const id of wanted) byId[id] = FORMER_COLLEAGUE;
  for (const user of users) byId[user.id] = reviewerLabel(user);
  return byId;
}
