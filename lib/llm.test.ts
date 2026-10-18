import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { afterEach, beforeEach } from "node:test";
import { ask, gatewayState, LLMUnavailable, llmStatus, probeGateway, resetCircuit } from "./llm";
import { setLogSink } from "./log";

// A fake gateway: a real HTTP server on a loopback port, so these tests exercise the OpenAI SDK, the per-request
// timeout, and the retry the way a live Bedrock endpoint would, instead of a stubbed client that cannot time out.

type Reply = { status: number; body?: unknown; hang?: boolean };

class FakeGateway {
  private server: Server | null = null;
  readonly requests: string[] = [];
  private replies: Reply[] = [];
  private fallback: Reply = { status: 200, body: { output_text: "ok" } };

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.requests.push(`${req.method} ${req.url}`);
      req.resume();
      const reply = this.replies.shift() ?? this.fallback;
      if (reply.hang) return; // never answers: the caller's timeout is the only way out
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? { error: { message: "fake gateway failure" } }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/openai/v1`;
  }

  /** Queue one reply per request, in order; later requests get `always`. */
  script(replies: Reply[], always?: Reply) {
    this.replies = [...replies];
    if (always) this.fallback = always;
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
  await gateway.stop();
  setLogSink();
  for (const name of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "BEDROCK_OPENAI_MODEL_ID", "LLM_TIMEOUT_MS", "LLM_CIRCUIT_THRESHOLD", "LLM_CIRCUIT_COOLDOWN_MS"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetCircuit();
});

test("a healthy gateway answers in one request and leaves the circuit closed", async () => {
  gateway.script([{ status: 200, body: { output_text: "Hello there." } }]);
  assert.equal(await ask("be brief", "hi"), "Hello there.");
  assert.equal(gateway.requests.length, 1);
  assert.equal(gatewayState(), "closed");
  assert.equal(llmStatus().degraded, false);
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
  await probeGateway();
  assert.equal(gatewayState(), "open", "a probe must not be able to close the circuit");
});
