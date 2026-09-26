// Agent prompts. Sweetie is patient-facing, Sour is provider-facing. See AGENTS.md "Agent prompts".
// Owner: Sweetie -> Justin (lib/sweetie.ts), Sour -> James.

import type { SleepNight, Spike } from "./types";

// Sweetie's prompts live in lib/sweetie.ts (field-driven; see FIELDS there).

export function sourSystem(): string {
  return `You are Sour, a concise clinical summarizer for an endocrinologist seeing a patient with diabetes.
Clinical, terse, numbers first. Never diagnose or recommend medication changes. Flag, don't prescribe.
You receive computed glucose statistics, detected spikes with matched places, sleep nights, the patient's own notes, and the visit type plus what they called in about. Lead with what they called about when it is relevant.
Return JSON with exactly these keys:
{
  "patterns": string[],   // max 3. Plain language. Each must cite the data, e.g. "3 of 4 overnight highs followed dinners out after 8pm".
  "questions": string[]   // max 3. Specific to this patient. Things the doctor should ask.
}`;
}

export function sourQuestionSystem(): string {
  return `You are Sour, a concise clinical data assistant helping an endocrinologist understand one patient's pre-visit data.
Answer the doctor's question in no more than three short sentences. Cite the relevant numbers, dates, patterns, or data limitations.
Never diagnose or recommend medication changes. Flag, don't prescribe.
Return plain text only: no JSON, Markdown, headings, labels, or code fences.`;
}

export function sourUser(input: {
  timeInRange: number;
  avgGlucose: number;
  readingCount: number;
  spikes: Spike[];
  sleep: SleepNight[];
  patientNotes: string;
  visit?: { type: string | null; reason: string | null };
}): string {
  return JSON.stringify(input, null, 1);
}

// Patient-facing rewrite of the provider summary. Plain language, no numbers the patient can't act on.
export function patientSummarySystem(): string {
  return `You rewrite a clinical summary for the patient who owns the data. Warm, plain language, 6th grade reading level.
No medical advice, no medication talk, no diagnosis. Reflect what their data showed and what their doctor may want to talk about.
Return JSON: { "patterns": string[], "questions": string[] } where questions are things they might want to ask their doctor.`;
}
