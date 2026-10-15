// Follow-up questions to Sour (design §2.6, §7.5). Owner: Justin (Sour).
//
// §7.5 is one sentence: "Follow-up questions to Sour are logged with the clinician id and the answer,
// visible on the page, never emailed." Before T18 the Discuss-with-Sour panel kept the conversation in React
// state, so it was none of those three things: a reload lost it, nobody could say later what had been asked
// about a patient, and the context the next question carried was whatever the browser still held.
//
// Four rules, all of them about the question being a record rather than a chat:
//
//   * **The question is written before the model call.** §6.2 says the same about a patient's message to
//     Sweetie, for the same reason: the gateway is the part that fails, and a question the clinician asked
//     should survive the answer not arriving. `answer` is null until it does.
//   * **The answer lands on the row that asked for it.** One update, by id, so two clinicians asking at the
//     same moment cannot cross answers.
//   * **The log belongs to the visit, not to the browser or to the clinician.** Everyone who may read the
//     visit's summary reads the same log, and that log is the context the next question is answered with
//     (§7.5's "logged ... visible on the page"), so a reload, a second clinician and a second device all
//     continue the same conversation.
//   * **Nothing here is ever sent anywhere.** No notification template takes a follow-up (lib/notify.ts),
//     and the one place that could leak one — the summary emails §8.2 allows — carries links only.
//
// No next/* imports and the client is a parameter, so lib/followUps.test.ts can drive the real writes through
// a throwaway schema (the same split as lib/review.ts, whose reviewerLabel names the asker here too).

import type { PrismaClient } from "@prisma/client";
import { db } from "./db";
import { reviewerLabel } from "./review";
import type { FollowUp } from "./types";

/** Only the part of the client this module uses, so a test can pass one pointed at a fixture schema. */
export type FollowUpClient = Pick<PrismaClient, "followUp" | "user">;

/** The clinician asking: the session's own user (lib/auth.ts ProviderUser). */
export type Asker = { id: string; name?: string | null; email?: string | null };

/** The longest question that is stored. The route refuses anything longer (and the input caps it at the same
 *  number), so this is the backstop rather than the check. */
export const MAX_QUESTION_CHARS = 4000;

/** The longest answer stored. Sour's replies are a short paragraph; a runaway one is cut rather than refused,
 *  because the clinician has already read it on the page and the log should hold what it can. */
export const MAX_ANSWER_CHARS = 8000;

/** How many of a visit's follow-ups the page shows, newest kept. A clinical conversation about one visit is
 *  a handful of questions; the cap is so a page cannot be made enormous by one. */
export const MAX_FOLLOW_UPS = 50;

/** How many answered pairs go into the next question's prompt. Six was what the browser used to send; it is
 *  kept, now read from the log instead of from page state. */
export const HISTORY_TURNS = 6;

/**
 * Write the question (§7.5), before the model is asked anything. Returns the row the page and the answer
 * both key off.
 */
export async function recordQuestion(
  visitId: string,
  asker: Asker,
  question: string,
  now: Date = new Date(),
  client: FollowUpClient = db,
): Promise<FollowUp> {
  const row = await client.followUp.create({
    data: { visitId, askedBy: asker.id, question: question.trim().slice(0, MAX_QUESTION_CHARS), createdAt: now },
  });
  return { id: row.id, at: row.createdAt.toISOString(), by: row.askedBy, byName: reviewerLabel(asker), question: row.question, answer: null };
}

/**
 * Attach Sour's answer to the question that asked for it. Returns the row as the page reads it, or null if
 * the row is gone — a visit deleted mid-answer (§10.5), which is not an error worth failing the reply over.
 */
export async function recordAnswer(
  id: string,
  answer: string,
  asker: Asker,
  now: Date = new Date(),
  client: FollowUpClient = db,
): Promise<FollowUp | null> {
  const updated = await client.followUp.updateMany({
    where: { id },
    data: { answer: answer.trim().slice(0, MAX_ANSWER_CHARS), answeredAt: now },
  });
  if (updated.count !== 1) return null;
  const row = await client.followUp.findUnique({ where: { id } });
  if (!row) return null;
  return { id: row.id, at: row.createdAt.toISOString(), by: row.askedBy, byName: reviewerLabel(asker), question: row.question, answer: row.answer };
}

/**
 * One visit's follow-up log, oldest first, as the page prints it: who asked, when, the question and the
 * answer. The asker's name is joined here and never stored beside the id — the same rule as the sign-off
 * (lib/review.ts) and the audit page.
 */
export async function followUpsFor(visitId: string, client: FollowUpClient = db): Promise<FollowUp[]> {
  const rows = await client.followUp.findMany({
    where: { visitId },
    orderBy: { createdAt: "desc" },
    take: MAX_FOLLOW_UPS,
  });
  if (!rows.length) return [];
  const ids = Array.from(new Set(rows.map((r) => r.askedBy).filter((id): id is string => Boolean(id))));
  const users = ids.length ? await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      by: row.askedBy,
      byName: reviewerLabel(row.askedBy ? byId.get(row.askedBy) : null),
      question: row.question,
      answer: row.answer,
    }));
}

/**
 * The recent conversation the next question is answered with: the last answered pairs on this visit, oldest
 * first. Unanswered rows are left out — a question the gateway refused has nothing to tell the model.
 */
export function historyFrom(followUps: readonly FollowUp[], turns = HISTORY_TURNS): { q: string; a: string }[] {
  return followUps
    .filter((f): f is FollowUp & { answer: string } => Boolean(f.answer?.trim()))
    .slice(-turns)
    .map((f) => ({ q: f.question, a: f.answer }));
}

/** The recent conversation as the prompt prints it. "(none)" rather than an empty block, so the model is not
 *  left to guess what an empty section means. */
export function renderHistory(history: readonly { q: string; a: string }[]): string {
  return history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n") || "(none)";
}
