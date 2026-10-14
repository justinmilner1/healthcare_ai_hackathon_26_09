// Structured JSON logging with a PHI allow-list (design §10.3, §11.1). Owner: compliance.
//
// One line of JSON per event on stdout (stderr for warn and error), which is all CloudWatch needs:
// see docs/LOGGING.md. Two rules hold the privacy line:
//
//   1. Allow-list. Only the field names in ALLOWED_FIELDS survive. Anything else is dropped and only its
//      *name* is reported back in `droppedFields`, never its value. So `log.info("invite", { email })`
//      logs no email, and the drop is visible in the log instead of silent.
//   2. Scrubbing. Free-text values that are allowed anyway (`error`, `stack`) are passed through scrub(),
//      which removes address- and number-shaped text before it is written, and caps length.
//
// Never add a field here that can hold a name, a phone number, an email address, a patient message, a
// summary, a visit reason, or a link token. Opaque database ids are fine; they are meaningless without
// the database, and the audit log (§10.2) is where reads of patient data get recorded.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { HttpError } from "./httpError";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

/** The only field names that reach the log. Grouped by why they are safe. */
export const ALLOWED_FIELDS: readonly string[] = [
  // Request plumbing (§11.1): how a line is tied back to one request.
  "requestId",
  "route",
  "method",
  "status",
  "durationMs",
  // Opaque identifiers. No names, no contact details, no link tokens.
  "patientId",
  "providerId",
  "practiceId",
  "userId",
  "visitId",
  "uploadId",
  "summaryId",
  "messageId",
  "jobId",
  // Operational facts about what happened, not about whom.
  "role",       // admin | clinician | staff (§5.2). One of three constants; never a name.
  "capability", // the capability a refused request asked for (lib/access.ts).
  "kind",
  "audience",
  "visitType",
  "channel",
  "provider",
  "sent",
  "count",
  "rows",
  "days",
  "bytes",
  "attempt",
  "attempts",
  "ok",
  "db",
  "degraded",
  "scripted",
  "target",
  "turns",
  "model",
  "effort",
  // Failures, scrubbed and capped.
  "code",
  "error",
  "stack",
];

const ALLOWED = new Set(ALLOWED_FIELDS);

const MAX_TEXT = 300;
const MAX_STACK = 1200;

/** Per-request context, so every line inside a request carries the same requestId without being passed it. */
type RequestContext = { requestId: string; route?: string };
const requestStore = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

/** The one shape of caller-supplied id worth reusing: the UUID we would have minted ourselves. Anything else
 *  is a stranger's text on every line of the request — `Jane Doe` sanitizes to `JaneDoe`, and a phone number is
 *  already hex-clean — so it is discarded and a fresh id is minted. Correlation across services costs the caller
 *  one UUID. */
const OPAQUE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIdFrom(headers: Headers | null | undefined): string {
  const given = headers?.get("x-request-id")?.trim();
  if (given && OPAQUE_REQUEST_ID.test(given)) return given.toLowerCase();
  return randomUUID();
}

/** Remove the shapes PHI arrives in (emails, phone numbers, long digit runs) and cap the length. */
export function scrub(text: string, max = MAX_TEXT): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function errorValue(value: unknown, max: number): string {
  if (value instanceof Error) return scrub(`${value.name}: ${value.message}`, max);
  if (typeof value === "string") return scrub(value, max);
  return scrub(String(value), max);
}

/** The allow-listed fields whose values are identifiers rather than text: a cuid from the database, or the
 *  UUID requestIdFrom enforces. None of them can hold PHI, and scrub() damages them (see sanitize). */
const ID_FIELDS = new Set(["requestId", "patientId", "providerId", "practiceId", "userId", "visitId", "uploadId", "summaryId", "messageId", "jobId"]);

// The two formats this app actually mints, and nothing wider. A charset check is not enough: `415-555-0132`
// and `4155550132` are made of identifier characters, so a lookup that logged an unresolved id straight from
// a request body would have printed a phone number that scrub() redacts today. Neither format can be one —
// a cuid starts with `c` and is 25 characters, a UUID is hex in the 8-4-4-4-12 shape.
const CUID = /^c[a-z0-9]{24}$/;

const isOpaqueId = (key: string, value: unknown): boolean =>
  ID_FIELDS.has(key) && typeof value === "string" && (CUID.test(value) || OPAQUE_REQUEST_ID.test(value));

/** Keep the allow-listed fields, scrub the free-text ones, and report the names that were dropped. */
export function sanitize(fields: Fields): Fields {
  const kept: Fields = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!ALLOWED.has(key)) {
      dropped.push(key);
      continue;
    }
    if (key === "error") kept[key] = errorValue(value, MAX_TEXT);
    else if (key === "stack") kept[key] = scrub(value instanceof Error ? (value.stack ?? "") : String(value), MAX_STACK);
    // An identifier goes through whole. scrub() otherwise reads a run of digits and hyphens as a phone number
    // and corrupts it: it mangled one minted request id in four — `d1e1ec17-9580-4837-8dc0-…` logged as
    // `d1e1ec[number]dc0-…` while the caller held the real id from the x-request-id header — and about one
    // database id in 6,100 the same way, so the §11.1 "follow one request" query returns nothing for them.
    // There is nothing in an identifier to scrub, and a value that is not shaped like one is scrubbed as usual.
    else if (isOpaqueId(key, value)) kept[key] = value as string;
    else if (typeof value === "string") kept[key] = scrub(value, MAX_TEXT);
    else if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else kept[key] = errorValue(value, MAX_TEXT);
  }
  if (dropped.length) kept.droppedFields = dropped.sort();
  return kept;
}

/** The exact line that gets written. Pure, so tests can read it without touching the process streams. */
export function formatLine(level: LogLevel, event: string, fields: Fields = {}, now = new Date()): string {
  const ctx = requestStore.getStore();
  return JSON.stringify({
    time: now.toISOString(),
    level,
    event: scrub(event, 80),
    ...sanitize({ requestId: ctx?.requestId, route: ctx?.route, ...fields }),
  });
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

let sink: LogSink = defaultSink;

/** Tests only: capture lines instead of writing them. Call with no argument to restore. */
export function setLogSink(next?: LogSink): void {
  sink = next ?? defaultSink;
}

function write(level: LogLevel, event: string, fields?: Fields): void {
  sink(level, formatLine(level, event, fields));
}

export const log = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};

// ---------------------------------------------------------------------------------------------
// Route wrapper. Every API route is exported through this, so each request gets an id, the id is
// available to any log call inside the handler, and one access line is written when it finishes.
// The id also goes back on the response as `x-request-id`, which is what a support request quotes.

type RouteHandler<R extends Request, C> = (req: R, ctx: C) => Response | Promise<Response>;

// Two overloads so a handler that ignores the route context can be wrapped (and called in a test) with the
// request alone, while a dynamic route keeps the exact `{ params }` type Next validates at build time.
export function withRoute<R extends Request>(route: string, handler: (req: R) => Response | Promise<Response>): (req: R, ctx?: unknown) => Promise<Response>;
export function withRoute<R extends Request, C>(route: string, handler: RouteHandler<R, C>): (req: R, ctx: C) => Promise<Response>;
export function withRoute<R extends Request, C>(route: string, handler: RouteHandler<R, C>) {
  return async (req: R, ctx: C): Promise<Response> => {
    const requestId = requestIdFrom(req.headers);
    const started = Date.now();
    return runWithRequestContext({ requestId, route }, async () => {
      // Exactly one access line per request. A refusal names itself in `event` — `request_forbidden` rather
      // than `request` — so a burst of them is one query away, and carries the guard's own allow-listed fields.
      const done = (res: Response, level: LogLevel, event: string, fields: Fields = {}): Response => {
        write(level, event, { method: req.method, status: res.status, durationMs: Date.now() - started, ...fields });
        try {
          res.headers.set("x-request-id", requestId);
        } catch {
          // A frozen header set is not worth failing a request over.
        }
        return res;
      };
      try {
        return done(await handler(req, ctx), "info", "request");
      } catch (e) {
        // A guard's refusal (lib/guard.ts) is an answer the route meant to give, not a crash: it carries its
        // own status and a message that says nothing about what is behind it.
        if (e instanceof HttpError) return done(e.response(), "warn", e.event, e.fields);
        // The message is scrubbed and capped; the stack says where, which is what a 500 needs.
        log.error("request_failed", { method: req.method, status: 500, durationMs: Date.now() - started, error: e, stack: e });
        throw e;
      }
    });
  };
}
