import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { HttpError } from "./httpError";
import { ALLOWED_FIELDS, formatLine, log, runWithRequestContext, requestIdFrom, sanitize, scrub, setLogSink, withRoute } from "./log";

const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

test("a log line is JSON with a time, a level, and an event", () => {
  const line = parse(formatLine("info", "upload_stored", { kind: "dexcom", count: 2016 }));
  assert.equal(line.level, "info");
  assert.equal(line.event, "upload_stored");
  assert.equal(line.kind, "dexcom");
  assert.equal(line.count, 2016);
  assert.match(String(line.time), /^\d{4}-\d{2}-\d{2}T/);
});

// The clock this file formats against, wherever a test searches a whole line for a needle.
//
// `formatLine` signs every line with `now.toISOString()` and takes `now` as its fourth argument. Left to the
// real clock, the stamp is part of the text those searches run over, and a needle as short as a three-digit
// number eventually collides with it: a millisecond field of exactly `555` put `555` in the line and failed
// the leak check below for a phone number that had in fact been dropped. One run in a thousand, and the whole
// check script with it. Pinning the clock leaves nothing in the line but what the test put there.
const CLOCK = new Date("2026-01-02T03:04:05.678Z");

test("fields outside the allow-list are dropped and only their names are reported", () => {
  const line = parse(
    formatLine("info", "invite_sent", {
      patientId: "p_1",
      name: "Jane Doe",
      phone: "+1 415 555 0132",
      email: "jane@example.com",
      notes: "woke at 3am sweating",
      token: "s3cr3t-link-token",
      reason: "mornings running high",
    }, CLOCK),
  );
  assert.equal(line.patientId, "p_1");
  assert.deepEqual(line.droppedFields, ["email", "name", "notes", "phone", "reason", "token"]);
  const text = JSON.stringify(line);
  for (const leak of ["Jane", "555", "jane@example.com", "sweating", "s3cr3t", "running high"]) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
});

test("the leak check above would still catch a value that really did reach the line", () => {
  // The guard on the guard. Pinning the clock removes the one thing that made that search fail by accident, so
  // this proves the search itself still works: `patientId` is allow-listed, a name put in it is kept, and the
  // same whole-line search finds it. Without this, a leak check that had quietly stopped matching would read
  // exactly like a leak check that passes.
  const line = parse(formatLine("info", "invite_sent", { patientId: "Jane Doe" }, CLOCK));
  assert.equal(line.patientId, "Jane Doe");
  assert.equal(JSON.stringify(line).includes("Jane"), true, "the leak check cannot find a value that is there");
});

test("the allow-list holds no field that carries a name, contact detail, or free text", () => {
  const forbidden = /^(name|firstName|lastName|patientName|providerName|phone|email|to|from|token|notes|message|content|transcript|reply|question|answer|summary|patterns|questions|reason|address|dob|flagged|body|subject|link|url)$/i;
  for (const field of ALLOWED_FIELDS) {
    assert.equal(forbidden.test(field), false, `${field} must not be allow-listed`);
  }
  assert.equal(new Set(ALLOWED_FIELDS).size, ALLOWED_FIELDS.length, "allow-list has duplicates");
});

test("scrub removes email- and number-shaped text and caps length", () => {
  assert.equal(scrub("mail jane.doe@example.com now"), "mail [email] now");
  assert.equal(scrub("call +1 (415) 555-0132 today"), "call [number] today");
  assert.equal(scrub("x".repeat(500)).length, 300);
});

test("an allowed free-text field is still scrubbed", () => {
  const line = parse(formatLine("error", "send_failed", { error: new Error("SES rejected jane@example.com (+14155550132)") }));
  assert.equal(line.error, "Error: SES rejected [email] ([number])");
});

test("sanitize keeps numbers and booleans as they are", () => {
  assert.deepEqual(sanitize({ status: 200, ok: true, sent: false, durationMs: 12 }), { status: 200, ok: true, sent: false, durationMs: 12 });
  assert.deepEqual(sanitize({ count: undefined }), {});
});

test("every line inside a request carries the same request id and route", () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    runWithRequestContext({ requestId: "req-abc", route: "POST /api/upload" }, () => {
      log.info("upload_received", { kind: "dexcom" });
      log.warn("parse_slow", { durationMs: 900 });
    });
    log.info("outside_request");
  } finally {
    setLogSink();
  }
  const parsed = lines.map(parse);
  assert.equal(parsed[0].requestId, "req-abc");
  assert.equal(parsed[0].route, "POST /api/upload");
  assert.equal(parsed[1].requestId, "req-abc");
  assert.equal(parsed[2].requestId, undefined);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("requestIdFrom reuses only an opaque caller id and otherwise mints one", () => {
  const given = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  assert.equal(requestIdFrom(new Headers({ "x-request-id": given })), given);
  assert.equal(requestIdFrom(new Headers({ "x-request-id": given.toUpperCase() })), given);
  assert.match(requestIdFrom(new Headers()), UUID);
  assert.match(requestIdFrom(null), UUID);
});

test("a caller cannot put text of their own on every line of a request", () => {
  // The header is client-controlled, and requestId is allow-listed, so it is the one way arbitrary text
  // could ride into the log. Anything that is not the shape we mint is thrown away.
  for (const hostile of ["Jane Doe", "JaneDoe", "jane@example.com", "4155550132", "abc-123", "x".repeat(200), "", "   "]) {
    const id = requestIdFrom(new Headers({ "x-request-id": hostile }));
    assert.match(id, UUID, `reused ${JSON.stringify(hostile)}`);
  }
});

test("a minted request id reaches the log whole", () => {
  // scrub() reads the digits and hyphens of a UUID as a phone number, which mangled one id in four:
  // `d1e1ec17-9580-4837-8dc0-bdb9e8a88e4f` was logged as `d1e1ec[number]dc0-bdb9e8a88e4f` while the caller
  // held the real id from the x-request-id header. A UUID carries nothing to scrub.
  for (const id of ["d1e1ec17-9580-4837-8dc0-bdb9e8a88e4f", "f81940ea-5424-4388-a7ae-d882c265b694", "58afbb93-0246-4903-8ef0-e2afa91429f9", "afce7b3e-57fd-4f92-9141-2a5b12a79284"]) {
    assert.equal(sanitize({ requestId: id }).requestId, id);
    assert.equal(parse(formatLine("info", "request", { requestId: id })).requestId, id);
  }
});

test("a request id that is not a minted uuid is still scrubbed", () => {
  assert.equal(sanitize({ requestId: "call +1 415 555 0132" }).requestId, "call [number]");
});

test("a database id reaches the log whole too", () => {
  // Same defect as the request id, rarer: a cuid with a run of nine digits reads as a phone number to
  // scrub(), which is about 1 in 6,100 of them. A mangled patientId points at no patient.
  for (const id of ["cmv2v8w2d00017dyqoi71y9pu", "clz123456789abcdefghijklm", "cmv31000000001xkpq8lwqynh"]) {
    assert.deepEqual(sanitize({ patientId: id, uploadId: id, jobId: id }), { patientId: id, uploadId: id, jobId: id });
  }
});

test("an id field holding something that is not an id is still scrubbed", () => {
  // The pass-through is for the two formats this app mints, so it cannot become a way in for anything else.
  assert.equal(sanitize({ patientId: "Jane Doe, 415-555-0132" }).patientId, "Jane Doe, [number]");
  assert.equal(sanitize({ patientId: "jane@example.com" }).patientId, "[email]");
  assert.equal(String(sanitize({ patientId: "x".repeat(500) }).patientId).length, 300);
});

test("a phone number in an id field is still redacted", () => {
  // A phone number is made of identifier characters, so a charset check would wave it through. If a lookup
  // ever logs an unresolved id straight from a request body, this is what stands between it and the log.
  for (const phone of ["415-555-0132", "4155550132", "+1 415 555 0132", "(415) 555-0132"]) {
    for (const field of ["patientId", "providerId", "visitId", "requestId", "jobId"]) {
      const out = sanitize({ [field]: phone })[field];
      assert.equal(String(out).includes("5550132"), false, `${field}=${phone} reached the log as ${String(out)}`);
    }
  }
});

test("the request id on the response is the one written to the log", async () => {
  // The property the header exists for. One run in four used to break it, so this walks enough ids to catch
  // a regression on the first failing shape rather than on a lucky one.
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    const handler = withRoute("GET /api/health", async () => new Response("{}", { status: 200 }));
    for (let i = 0; i < 200; i++) {
      lines.length = 0;
      const res = await handler(new Request("http://localhost/api/health"));
      assert.equal(parse(lines[0]).requestId, res.headers.get("x-request-id"));
    }
  } finally {
    setLogSink();
  }
});

test("withRoute logs one access line and echoes the request id on the response", async () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  let handler: (req: Request) => Promise<Response>;
  try {
    handler = withRoute("GET /api/health", async () => {
      log.info("db_checked", { db: "ok" });
      return new Response("{}", { status: 200 });
    });
    const res = await handler(new Request("http://localhost/api/health", { headers: { "x-request-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301" } }));
    assert.equal(res.headers.get("x-request-id"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  } finally {
    setLogSink();
  }
  const parsed = lines.map(parse);
  assert.equal(parsed[0].event, "db_checked");
  assert.equal(parsed[0].requestId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(parsed[1].event, "request");
  assert.equal(parsed[1].route, "GET /api/health");
  assert.equal(parsed[1].method, "GET");
  assert.equal(parsed[1].status, 200);
  assert.equal(typeof parsed[1].durationMs, "number");
});

test("withRoute answers a guard's refusal and logs it as the access line, not as a crash", async () => {
  // A 403 from lib/guard.ts is an answer the route meant to give (§5.2), so there is still exactly one access
  // line — named after the refusal, and carrying the role and capability the allow-list now admits (§10.3).
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  let res: Response;
  try {
    const handler = withRoute("POST /api/practice/users", async () => {
      throw new HttpError(403, "A staff account cannot do this. Ask an admin in your practice.", "request_forbidden", {
        userId: "cuser0000000000000000000a",
        role: "staff",
        capability: "users:manage",
        email: "maya@practice.com",
      });
    });
    res = await handler(new Request("http://localhost/api/practice/users", { method: "POST" }));
  } finally {
    setLogSink();
  }

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "A staff account cannot do this. Ask an admin in your practice." });
  assert.equal(res.headers.get("x-request-id"), parse(lines[0]).requestId);

  assert.equal(lines.length, 1, "one access line per request, refused or not");
  const line = parse(lines[0]);
  assert.equal(line.level, "warn");
  assert.equal(line.event, "request_forbidden");
  assert.equal(line.status, 403);
  assert.equal(line.route, "POST /api/practice/users");
  assert.equal(line.role, "staff");
  assert.equal(line.capability, "users:manage");
  // The allow-list still applies to a guard's fields: an address is dropped by name, like anywhere else.
  assert.equal(JSON.stringify(line).includes("maya@practice.com"), false);
  assert.deepEqual(line.droppedFields, ["email"]);
});

test("withRoute logs a scrubbed failure and rethrows", async () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    const handler = withRoute("POST /api/book", async () => {
      throw new Error("insert failed for jane@example.com");
    });
    await assert.rejects(() => handler(new Request("http://localhost/api/book", { method: "POST" })));
  } finally {
    setLogSink();
  }
  const line = parse(lines[0]);
  assert.equal(line.level, "error");
  assert.equal(line.event, "request_failed");
  assert.equal(line.status, 500);
  assert.equal(line.error, "Error: insert failed for [email]");
  assert.match(String(line.stack), /log\.test\.ts/);
  assert.equal(JSON.stringify(line).includes("jane@example.com"), false);
});

// The enforcement half of the ticket: application code logs through lib/log.ts and nothing else.
// `npm run lint` fails on console.* in these directories too (eslint.config.mjs); this test keeps the
// rule honest if the lint config ever loosens, and catches process.stdout writes outside the logger.
const APP_DIRS = ["app", "lib", "components"];
const LOGGER = path.join("lib", "log.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

test("no console or raw stream writes in application code", () => {
  const offenders: string[] = [];
  for (const dir of APP_DIRS) {
    for (const file of sourceFiles(dir)) {
      if (file === LOGGER) continue;
      const src = readFileSync(file, "utf8");
      if (/\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\b/.test(src)) offenders.push(`${file}: console.*`);
      if (/\bprocess\s*\.\s*(stdout|stderr)\s*\.\s*write\b/.test(src)) offenders.push(`${file}: process.stdout.write`);
    }
  }
  assert.deepEqual(offenders, [], `log through lib/log.ts instead:\n${offenders.join("\n")}`);
});

test("every API route is wrapped by withRoute", () => {
  const routes = sourceFiles("app").filter((f) => f.endsWith(`${path.sep}route.ts`));
  assert.ok(routes.length > 0, "no route files found");
  const missing = routes.filter((f) => !readFileSync(f, "utf8").includes("withRoute("));
  assert.deepEqual(missing, [], "these routes log no request id");
});
