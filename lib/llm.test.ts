import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { afterEach, beforeEach } from "node:test";
import { ask, gatewayState, LLMUnavailable, llmStatus, probeGateway, resetCircuit } from "./llm";
import { setLogSink } from "./log";

// A fake gateway: a real HTTP server on a loopback port, so these tests exercise the OpenAI SDK, the per-request
// timeout, and the retry the way a live Bedrock endpoint would, instead of a stubbed client that cannot time out.

type Reply = { status: number; body?: unknown; hang?: boolean };

/** What an unscripted request is answered with: a status `lib/llm.ts` neither retries nor rethrows, so one
 *  stray request stays one request, and a body that says where to look. The status matters less than the fact
 *  that it is not a success — see `takeUnscripted`. */
const UNSCRIPTED = 418;

class FakeGateway {
  private server: Server | null = null;
  readonly requests: string[] = [];
  private replies: Reply[] = [];
  private fallback: Reply | null = null;
  private unscripted: string[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const label = `${req.method} ${req.url}`;
      this.requests.push(label);
      req.resume();
      const reply = this.replies.shift() ?? this.fallback;
      if (!reply) {
        // Nothing scripted this request, so there is no answer to give it that means anything. This used to be
        // a cheerful `200 OK {"output_text":"ok"}`, and that was the T88 bug: `lib/llm.ts` retries once, so on a
        // loaded box a healthy call timed out, retried, and the retry was served from the fallback — `ask`
        // returned `"ok"` and the assertion failed on the *value* rather than on the clock that was the cause.
        this.unscripted.push(label);
        res.writeHead(UNSCRIPTED, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `FakeGateway: nothing scripted ${label} (see T88)` } }));
        return;
      }
      if (reply.hang) return; // never answers: the caller's timeout is the only way out
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? { error: { message: "fake gateway failure" } }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/openai/v1`;
  }

  /** Queue one reply per request, in order; later requests get `always`, or the refusal above if there is no
   *  `always`. Each call replaces both, so a test cannot inherit the previous one's standing reply. */
  script(replies: Reply[], always?: Reply) {
    this.replies = [...replies];
    this.fallback = always ?? null;
  }

  /** The requests nothing scripted, and a promise that they are accounted for: `afterEach` fails the test on
   *  any left over, and the one test whose subject *is* an unscripted request claims them here. */
  takeUnscripted(): string[] {
    const taken = [...this.unscripted];
    this.unscripted.length = 0;
    return taken;
  }

  async stop() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

let gateway: FakeGateway;
const saved = { ...process.env };

beforeEach(async () => {
  setLogSink(() => {}); // the module logs every failure; tests do not need the noise
  gateway = new FakeGateway();
  process.env.OPENAI_BASE_URL = await gateway.start();
  process.env.OPENAI_API_KEY = "fake-key";
  process.env.BEDROCK_OPENAI_MODEL_ID = "openai.gpt-5.5";
  // Generous on purpose. This is the budget for a *healthy* call to a loopback server, and 200ms of it was a
  // trap: one round trip through the OpenAI SDK can exceed that on a loaded box, so `lib/llm.ts` timed the
  // call out, retried, timed out again and reported `LLMUnavailable` — a red run naming the model client for
  // what was only the clock (T88). A test whose subject *is* the timeout sets its own, below; nothing else
  // should be able to reach this one.
  process.env.LLM_TIMEOUT_MS = "5000";
  process.env.LLM_CIRCUIT_THRESHOLD = "2";
  process.env.LLM_CIRCUIT_COOLDOWN_MS = "60000";
  resetCircuit();
});

afterEach(async () => {
  const unscripted = gateway.takeUnscripted();
  await gateway.stop();
  setLogSink();
  for (const name of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "BEDROCK_OPENAI_MODEL_ID", "LLM_TIMEOUT_MS", "LLM_CIRCUIT_THRESHOLD", "LLM_CIRCUIT_COOLDOWN_MS"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetCircuit();
  // Last, after the cleanup, so a stray request cannot also leak a server or an environment variable into the
  // next test. A request nobody scripted is a test asserting against a reply it did not choose (T88).
  assert.deepEqual(unscripted, [], `FakeGateway was asked ${unscripted.length} unscripted request(s): ${unscripted.join(", ")}`);
});

test("a healthy gateway answers in one request and leaves the circuit closed", async () => {
  gateway.script([{ status: 200, body: { output_text: "Hello there." } }]);
  assert.equal(await ask("be brief", "hi"), "Hello there.");
  assert.equal(gateway.requests.length, 1);
  assert.equal(gatewayState(), "closed");
  assert.equal(llmStatus().degraded, false);
});

test("a request no test scripted is refused, so a retry can never pass for the scripted reply", async () => {
  // The guard behind every assertion in this file. `FakeGateway` used to answer anything it had no script for
  // with `200 OK {"output_text":"ok"}`, so the retry in `lib/llm.ts` could serve a timed-out healthy call a
  // success: the test above then failed with `actual: 'ok'`, naming the model client for what was the clock
  // (T88). An unscripted request is now a refusal the gateway also records, and `afterEach` fails any test
  // that leaves one unclaimed.
  gateway.script([]);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gateway.requests.length, 1, "the refusal is not transient, so it is not retried");
  assert.deepEqual(gateway.takeUnscripted(), ["POST /openai/v1/responses"]);
});

test("a call that never answers times out and is retried once, then reports unavailable", async () => {
  // The one test the timeout belongs to, so it is short here and nowhere else: the gateway never answers, so
  // waiting is the whole point and every millisecond of it is spent twice.
  process.env.LLM_TIMEOUT_MS = "200";
  gateway.script([{ status: 200, hang: true }, { status: 200, hang: true }]);
  const started = Date.now();
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  // Two attempts of LLM_TIMEOUT_MS each, and nothing like the 20 s production budget.
  assert.ok(Date.now() - started >= 200, "did not wait for the timeout");
  assert.equal(gateway.requests.length, 2, "expected one retry");
});

test("a transient failure is retried and the retry's answer is returned", async () => {
  gateway.script([{ status: 503 }, { status: 200, body: { output_text: "second time lucky" } }]);
  assert.equal(await ask("be brief", "hi"), "second time lucky");
  assert.equal(gateway.requests.length, 2);
  assert.equal(gatewayState(), "closed", "a recovered call must not leave failures behind");
});

test("a rejected key is not retried: one request, then unavailable", async () => {
  gateway.script([{ status: 401, body: { error: { message: "bad key" } } }], { status: 401 });
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gateway.requests.length, 1, "401 is not transient");
});

test("a malformed request surfaces as itself, not as a friendly fallback", async () => {
  // A 400 is this code's bug. Hiding it behind LLMUnavailable would ship scripted answers forever and silently.
  gateway.script([{ status: 400, body: { error: { message: "unknown parameter" } } }], { status: 400 });
  await assert.rejects(() => ask("be brief", "hi"), (e: unknown) => {
    assert.equal(e instanceof LLMUnavailable, false);
    assert.equal((e as { status?: number }).status, 400);
    return true;
  });
  assert.equal(gateway.requests.length, 1);
  assert.equal(gatewayState(), "closed", "a caller error is not an outage");
});

test("repeated failures open the circuit, and an open circuit answers without touching the network", async () => {
  gateway.script([], { status: 503 });
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  // Threshold 2: two failed calls (two HTTP attempts each) and the circuit is open.
  assert.equal(gateway.requests.length, 4);
  assert.equal(gatewayState(), "open");
  assert.equal(llmStatus().degraded, true);

  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gateway.requests.length, 4, "an open circuit must not call the gateway");
});

test("after the cooldown one probe is let through, and it closes the circuit", async () => {
  process.env.LLM_CIRCUIT_COOLDOWN_MS = "50";
  gateway.script([], { status: 503 });
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gatewayState(), "open");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gatewayState(), "half_open");

  const before = gateway.requests.length;
  gateway.script([{ status: 200, body: { output_text: "back up" } }]);
  assert.equal(await ask("be brief", "hi"), "back up");
  assert.equal(gateway.requests.length, before + 1, "the probe is a single request");
  assert.equal(gatewayState(), "closed");
  assert.equal(llmStatus().degraded, false);
});

test("a failed probe re-opens the circuit instead of letting every call through", async () => {
  process.env.LLM_CIRCUIT_COOLDOWN_MS = "50";
  gateway.script([], { status: 503 });
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(gatewayState(), "half_open");

  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gatewayState(), "open");
});

test("no API key is unavailable without a request, which is what offline development relies on", async () => {
  delete process.env.OPENAI_API_KEY;
  assert.equal(llmStatus().configured, false);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gateway.requests.length, 0);
});

test("json mode parses the object out of a fenced answer", async () => {
  gateway.script([{ status: 200, body: { output_text: "```json\n{\"patterns\":[\"a\"]}\n```" } }]);
  const parsed = await ask<{ patterns: string[] }>("be brief", "hi", { json: true });
  assert.deepEqual(parsed.patterns, ["a"]);
});

test("prose instead of JSON costs one more call, and that is not an outage", async () => {
  gateway.script([
    { status: 200, body: { output_text: "Sorry, I cannot do that." } },
    { status: 200, body: { output_text: "{\"patterns\":[\"b\"]}" } },
  ]);
  const parsed = await ask<{ patterns: string[] }>("be brief", "hi", { json: true });
  assert.deepEqual(parsed.patterns, ["b"]);
  assert.equal(gateway.requests.length, 2);
  assert.equal(gatewayState(), "closed");
});

// ---- probeGateway: the §11.2 reachability check, not a model call --------------------------------------

test("the health probe asks the gateway nothing: one bare GET, no key, no tokens", async () => {
  gateway.script([{ status: 200, body: { object: "list", data: [] } }]);
  await probeGateway();
  assert.equal(gateway.requests.length, 1);
  assert.match(gateway.requests[0], /^GET \/openai\/v1/);
  // Nothing was asked of the model, so nothing about the circuit changed.
  assert.equal(gatewayState(), "closed");
});

test("any answer at all counts as reachable: Bedrock replies 403 to this and that is still up", async () => {
  gateway.script([], { status: 403, body: { error: { message: "no" } } });
  await probeGateway();
  assert.equal(gateway.requests.length, 1);
});

test("nothing listening is unavailable, and says so without the SDK's help", async () => {
  await gateway.stop(); // the port is now closed: ECONNREFUSED
  await assert.rejects(() => probeGateway(), LLMUnavailable);
});

test("a gateway that never answers is bounded by the probe's own timeout", async () => {
  gateway.script([{ status: 200, hang: true }]);
  const started = Date.now();
  await assert.rejects(() => probeGateway(200), LLMUnavailable);
  assert.ok(Date.now() - started < 2_000, "the probe waited for the model timeout instead of its own");
});

test("no API key is a skipped probe, not a request", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => probeGateway(), LLMUnavailable);
  assert.equal(gateway.requests.length, 0);
});

test("a successful probe does not close a circuit that real calls opened", async () => {
  // Health has to keep saying "degraded" until an actual call succeeds. The port answering again is not that:
  // a gateway that 500s on every Responses call answers this probe perfectly.
  gateway.script([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  await assert.rejects(() => ask("be brief", "hi"), LLMUnavailable);
  assert.equal(gatewayState(), "open");
  // The probe's own request, scripted on purpose: the gateway answering a bare GET perfectly while every
  // Responses call 500s is exactly the situation this test is about.
  gateway.script([{ status: 200, body: { object: "list", data: [] } }]);
  await probeGateway();
  assert.equal(gatewayState(), "open", "a probe must not be able to close the circuit");
});
