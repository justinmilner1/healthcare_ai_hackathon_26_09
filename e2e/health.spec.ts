import { expect, test, type APIResponse } from "@playwright/test";

// Design §11.2 against the running build: the health endpoint checks three dependencies, says how long each
// one took, and answers 503 when one of them is down.
//
// Two servers from playwright.config.ts make both answers real, with nothing stubbed:
//
//   port    database and uploads reachable, no model key at all -> 200, the model check `skipped`
//   port+1  the same build with a key configured and OPENAI_BASE_URL on a closed loopback port -> 503
//
// The second one is the whole point of the ticket. A health endpoint that only ever returns 200 in the suite
// proves nothing about the deploy gate it exists for.

const PORT = Number(process.env.E2E_PORT ?? 3100);

type Check = { status: string; latencyMs: number; detail: string };
type Report = { ok: boolean; status: string; checks: Record<"db" | "storage" | "model", Check> };

async function report(res: APIResponse): Promise<Report> {
  expect(res.headers()["cache-control"], "a cached health report is worse than none").toContain("no-store");
  return (await res.json()) as Report;
}

/** Every check names a status, a duration, and one word of detail — and never an error message. */
function expectWellFormed(body: Report) {
  expect(Object.keys(body.checks)).toEqual(["db", "storage", "model"]);
  for (const [name, check] of Object.entries(body.checks)) {
    expect(["ok", "down", "skipped"], name).toContain(check.status);
    expect(typeof check.latencyMs, `${name} latency`).toBe("number");
    expect(check.latencyMs, `${name} latency`).toBeGreaterThanOrEqual(0);
    // §11.2's "with latencies" has to mean a real measurement, and a load balancer's budget is the ceiling:
    // the three probes run together, so no check should be anywhere near it.
    expect(check.latencyMs, `${name} latency`).toBeLessThan(10_000);
    expect(check.detail, `${name} detail`).toMatch(/^[a-z_0-9]+$/);
  }
}

test.describe("everything it needs is reachable", () => {
  test("the three checks are reported with latencies, and an unconfigured model is not an outage", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await report(res);

    expectWellFormed(body);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.checks.db.status).toBe("ok");
    // This server writes uploads to a directory, not a bucket (§3.3); the report says which it checked.
    expect(body.checks.storage.status).toBe("ok");
    expect(body.checks.storage.detail).toBe("local");
    // No key is the scripted mode §3.5 and §11.3 ask us to support, so it is `skipped` and the report is ok.
    expect(body.checks.model.status).toBe("skipped");
    expect(body.checks.model.detail).toBe("not_configured");
  });

  test("the report says nothing about any patient, practice or host", async ({ request }) => {
    // It answers without a session (lib/access.test.ts), so what it says is public. A Prisma connection error
    // carries the database host and user, and the body is where that used to end up.
    const text = await (await request.get("/api/health")).text();
    expect(text.length, "a health report should be a few hundred bytes, not a page").toBeLessThan(2_000);
    expect(text).not.toMatch(/postgres|postgresql|sweetspot@|@localhost|5432|password|secret|Error:/i);
  });

  test("liveness touches nothing and says so", async ({ request }) => {
    const res = await request.get("/api/health/live");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("the report renders for an operator who just opens the URL", async ({ page }) => {
    const res = await page.goto("/api/health");
    expect(res?.status()).toBe(200);
    await expect(page.locator("body")).toContainText('"status":"ok"');
    // Not fullPage: the body is two lines, and Chromium's JSON viewer reports a page several thousand pixels
    // tall on the phone profile, which is a screenshot of nothing (T57).
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-health-ok.png` });
  });
});

test.describe("the model gateway is down", () => {
  test.use({ baseURL: `http://localhost:${PORT + 1}` });

  test("a configured gateway that cannot be reached is 503, and the other two still report ok", async ({ request }) => {
    const res = await request.get("/api/health");
    // The deploy gate's verdict: this release is not promotable, whichever dependency it is.
    expect(res.status()).toBe(503);
    const body = await report(res);

    expectWellFormed(body);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("down");
    expect(body.checks.model.status).toBe("down");
    // `unreachable` on the first failure; `circuit_open` once lib/llm.ts has given up on it, which an earlier
    // spec on this same server may already have done. Both are the gateway being down, and neither is an
    // error message.
    expect(["unreachable", "circuit_open"]).toContain(body.checks.model.detail);
    // One dependency down must not be reported as three: an operator needs to know which.
    expect(body.checks.db.status).toBe("ok");
    expect(body.checks.storage.status).toBe("ok");
  });

  test("liveness still answers, because the app serves through a model outage", async ({ request }) => {
    // §11.3: Sweetie falls back to the scripted path and Sour defers, so a load balancer must not drain this
    // task. e2e/degraded.spec.ts is the patient's half of the same claim.
    const res = await request.get("/api/health/live");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("the 503 renders for an operator who just opens the URL", async ({ page }) => {
    const res = await page.goto("/api/health");
    expect(res?.status()).toBe(503);
    await expect(page.locator("body")).toContainText('"status":"down"');
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-health-degraded.png` });
  });
});
