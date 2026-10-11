// The only place that talks to the model. GPT-5.5 on Bedrock via the OpenAI SDK, Responses API only.
// Usage: const text = await ask(system, user); const obj = await ask<MyType>(system, user, { json: true });
//
// Every call is bounded and every failure degrades instead of 500ing (design §3.5, §6.3, §11.3):
//
//   Timeout.  LLM_TIMEOUT_MS (default 20 s) per HTTP attempt. The SDK's own retries are off, so this module
//             is the only thing that decides when to try again.
//   Retry.    One retry, and only for transient failures: a timeout, a dropped connection, 408/409/425/429,
//             or a 5xx. A 401 is not transient — trying a bad key twice is just slower.
//   Circuit.  LLM_CIRCUIT_THRESHOLD consecutive failed calls (default 3) open the circuit for
//             LLM_CIRCUIT_COOLDOWN_MS (default 60 s). While it is open, ask() throws LLMUnavailable without
//             touching the network; after the cooldown one probe call is let through, and its result either
//             closes the circuit or re-opens it.
//
// All three end the same way: `ask` throws LLMUnavailable, which is the signal every caller already handles by
// answering from its scripted path (lib/sweetie.ts `scripted`, lib/sourRun.ts placeholder patterns). A missing
// OPENAI_API_KEY throws the same error, so offline development and a dead gateway take one code path.
// `llmStatus()` reports the state so a page can say so: see the degraded note in app/s/[token]/page.tsx.
//
// The one exception is a request this code built wrong (400, 422). That is a bug, not an outage, so it is
// rethrown unchanged rather than hidden behind a friendly fallback.

import OpenAI from "openai";
import { log } from "./log";

export class LLMUnavailable extends Error {}

/** One client per (baseURL, key). Keyed rather than a bare singleton so a changed environment — a test's fake
 *  gateway, a rotated key — is not served by a client still pointing at the old one. */
let cached: { key: string; client: OpenAI } | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new LLMUnavailable("OPENAI_API_KEY is not set; see .env.example");
  }
  const baseURL = process.env.OPENAI_BASE_URL;
  const key = `${baseURL ?? ""}|${apiKey}`;
  if (!cached || cached.key !== key) {
    // maxRetries: 0 — retrying is this module's job (see the header), and the SDK's own three attempts would
    // multiply every timeout by three and hide the failures the circuit counts.
    cached = { key, client: new OpenAI({ baseURL, apiKey, maxRetries: 0 }) };
  }
  return cached.client;
}

export const MODEL = () => process.env.BEDROCK_OPENAI_MODEL_ID ?? "openai.gpt-5.5";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

/** Read at call time, not at import time, so a test (or a restart-free config change) can set them. */
function setting(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const timeoutMs = () => setting("LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

// ---- Circuit ---------------------------------------------------------------------------------------------

export type GatewayState = "closed" | "open" | "half_open";

const circuit = { failures: 0, openedAt: null as number | null };

/** `open` short-circuits; `half_open` lets one probe through; `closed` is business as usual. */
export function gatewayState(now = Date.now()): GatewayState {
  if (circuit.openedAt === null) return "closed";
  return now - circuit.openedAt >= setting("LLM_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS) ? "half_open" : "open";
}

/** What a page needs to tell the patient why the answers suddenly read like a form.
 *  `configured` is whether a model is wired up at all; `degraded` is whether a configured one is failing.
 *  They are separate because the page says different things: "Demo mode" versus the §6.3 outage note. */
export function llmStatus(): { configured: boolean; model: string; state: GatewayState; degraded: boolean } {
  const state = gatewayState();
  return { configured: Boolean(process.env.OPENAI_API_KEY), model: MODEL(), state, degraded: state !== "closed" };
}

/** Forget the failures. Called on a successful call; exported for tests and for an operator-facing reset. */
export function resetCircuit(): void {
  circuit.failures = 0;
  circuit.openedAt = null;
}

function recordSuccess(): void {
  if (circuit.openedAt !== null) log.info("llm_circuit_closed", { attempts: circuit.failures, degraded: false });
  resetCircuit();
}

function recordFailure(): void {
  circuit.failures += 1;
  const threshold = setting("LLM_CIRCUIT_THRESHOLD", DEFAULT_THRESHOLD);
  if (circuit.failures >= threshold) {
    const reopened = circuit.openedAt !== null;
    circuit.openedAt = Date.now();
    if (!reopened) log.warn("llm_circuit_opened", { attempts: circuit.failures, degraded: true });
  }
}

// ---- Failure classification ------------------------------------------------------------------------------

const httpStatus = (e: unknown): number | undefined => {
  const status = (e as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
};

const errorCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" ? code : undefined;
};

/** A request this code built wrong. Not an outage: let it surface so it gets fixed. */
function isCallerError(e: unknown): boolean {
  const status = httpStatus(e);
  return status === 400 || status === 422;
}

/** Worth exactly one more try: the gateway was unreachable, slow, busy, or briefly broken. */
function isTransient(e: unknown): boolean {
  if (e instanceof OpenAI.APIConnectionError) return true; // covers APIConnectionTimeoutError
  const status = httpStatus(e);
  if (status !== undefined) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const code = errorCode(e);
  if (code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT))$/.test(code)) return true;
  return e instanceof Error && /abort|timeout/i.test(e.name);
}

// ---- The call --------------------------------------------------------------------------------------------

type AskOptions = {
  json?: boolean;
  effort?: "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
};

/** One logical call: up to two HTTP attempts, one circuit entry. Throws LLMUnavailable if both attempts fail. */
async function call(system: string, user: string, opts: AskOptions): Promise<string> {
  const client = getClient();
  const state = gatewayState();
  if (state === "open") {
    log.warn("llm_skipped_circuit_open", { degraded: true, scripted: true });
    throw new LLMUnavailable("model gateway circuit is open");
  }

  const started = Date.now();
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await client.responses.create(
        {
          model: MODEL(),
          input: [
            { role: "developer", content: opts.json ? system + "\n\nRespond with a single JSON object and nothing else." : system },
            { role: "user", content: user },
          ],
          reasoning: { effort: opts.effort ?? "medium" },
          text: { verbosity: opts.verbosity ?? "low" },
        },
        { timeout: timeoutMs(), maxRetries: 0 },
      );
      recordSuccess();
      return res.output_text ?? "";
    } catch (e) {
      if (isCallerError(e)) throw e;
      last = e;
      const willRetry = attempt === 1 && isTransient(e);
      log.warn("llm_call_failed", {
        attempt,
        model: MODEL(),
        effort: opts.effort ?? "medium",
        status: httpStatus(e),
        code: errorCode(e),
        durationMs: Date.now() - started,
        error: e,
      });
      if (!willRetry) break;
    }
  }

  // One failure per logical call, so "three failures" means three answers the patient did not get, not
  // three HTTP attempts.
  recordFailure();
  const reason = last instanceof Error ? `${last.name}: ${last.message}` : String(last);
  throw new LLMUnavailable(`model gateway unavailable (${reason})`);
}

export async function ask(system: string, user: string, opts?: { json?: false } & AskOptions): Promise<string>;
export async function ask<T>(system: string, user: string, opts: { json: true } & AskOptions): Promise<T>;
export async function ask<T>(system: string, user: string, opts: AskOptions = {}): Promise<string | T> {
  const text = await call(system, user, opts);
  if (!opts.json) return text;

  try {
    return parseJson<T>(text);
  } catch {
    // Retry once on parse failure (AGENTS.md). A model that answers in prose is not a gateway outage, so this
    // retry is separate from the transport retry above and does not count against the circuit.
    log.warn("llm_json_parse_failed", { model: MODEL(), attempt: 1 });
    const again = await call(system, user, opts);
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
