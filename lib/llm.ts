// The only place that talks to the model. GPT-5.5 on Bedrock via the OpenAI SDK, Responses API only.
// Usage: const text = await ask(system, user); const obj = await ask<MyType>(system, user, { json: true });
// If OPENAI_API_KEY is unset, ask() throws LLMUnavailable so callers can fall back to a stub.

import OpenAI from "openai";

export class LLMUnavailable extends Error {}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new LLMUnavailable("OPENAI_API_KEY is not set; see .env.example");
  }
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return client;
}

export const MODEL = () => process.env.BEDROCK_OPENAI_MODEL_ID ?? "openai.gpt-5.5";

type AskOptions = {
  json?: boolean;
  effort?: "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
};

export async function ask(system: string, user: string, opts?: { json?: false } & AskOptions): Promise<string>;
export async function ask<T>(system: string, user: string, opts: { json: true } & AskOptions): Promise<T>;
export async function ask<T>(system: string, user: string, opts: AskOptions = {}): Promise<string | T> {
  const c = getClient();
  const run = async () => {
    const res = await c.responses.create({
      model: MODEL(),
      input: [
        { role: "developer", content: opts.json ? system + "\n\nRespond with a single JSON object and nothing else." : system },
        { role: "user", content: user },
      ],
      reasoning: { effort: opts.effort ?? "medium" },
      text: { verbosity: opts.verbosity ?? "low" },
    });
    return res.output_text ?? "";
  };

  const text = await run();
  if (!opts.json) return text;

  try {
    return parseJson<T>(text);
  } catch {
    // Retry once on parse failure (AGENTS.md).
    const again = await run();
    return parseJson<T>(again);
  }
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON object in model output");
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}
