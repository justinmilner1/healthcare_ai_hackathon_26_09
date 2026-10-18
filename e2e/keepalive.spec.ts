import net from "node:net";

import { expect, test } from "@playwright/test";

// T59 — the gate's own transport, not a feature. Design §12.2 and §12.4: the suite is the gate on every merge,
// so a test that fails for a reason that is not the code under test costs a full rerun and, worse, makes a red
// run say nothing about the branch under it.
//
// Node closes an idle keep-alive socket after `server.keepAliveTimeout`, which a plain `next start` leaves at
// its five-second default, and Playwright's `APIRequestContext` pools its connections and does not retry a
// reset. A `request.*` call that reuses a pooled socket in the moment the server is retiring it is therefore
// written to a socket that answers RST, and the test dies on the call with `read ECONNRESET` before reaching
// an assertion. That is what took runs down from `deletion.spec.ts`, `flows.spec.ts`, `durability.spec.ts`,
// `followup.spec.ts` and `mobile.spec.ts` in turn, with no route, verb or load in common.
//
// `playwright.config.ts` fixes it at the server end, with `next start --keepAliveTimeout`, so this asserts the
// property that fix provides: the server does not hang up on an idle connection, and the connection still
// answers after a gap longer than the default it used to close at. Raw sockets rather than the `request`
// fixture, because the transport underneath the fixture is the thing being tested — a pooled client that found
// its socket gone would quietly open a second one and pass either way.

const PORT = Number(process.env.E2E_PORT ?? 3100);

/** Past the five-second default, and past the 6.0s at which this build was measured to send FIN without the
 *  flag. Short enough to stay well inside the 60s test timeout. */
const IDLE_MS = 10_000;

/** Resolve once `done()` is true, or fail the wait after `within` ms. */
async function until(done: () => boolean, within: number, what: string) {
  const deadline = Date.now() + within;
  while (!done()) {
    expect(Date.now(), what).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("the server holds an idle keep-alive socket, so a reused connection is never reset (T59)", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "no browser is involved; once per run is the whole check");

  const socket = net.connect(PORT, "127.0.0.1");
  // Why the socket stopped being usable, if it did. The server closing it is the bug; an RST is what the
  // suite used to see one tick later, when a request had already been written to it.
  const closedBy: string[] = [];
  let received = "";
  socket.setKeepAlive(false);
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
  });
  socket.on("end", () => closedBy.push("FIN from the server"));
  socket.on("error", (error: NodeJS.ErrnoException) => closedBy.push(`socket error ${error.code}`));

  const get = () =>
    socket.write(`GET /api/health/live HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: keep-alive\r\n\r\n`);

  try {
    await until(() => socket.readyState === "open", 10_000, "the socket should connect");
    get();
    await until(() => received.includes("\r\n\r\n"), 20_000, "the server should answer the first request");
    expect(received, "liveness should answer 200, and keep the connection").toContain("HTTP/1.1 200");

    // The gap. Without the flag in playwright.config.ts the server sends FIN in the middle of this.
    const afterFirst = received.length;
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    expect(
      closedBy,
      `the server closed an idle connection after ${IDLE_MS}ms; raise --keepAliveTimeout in playwright.config.ts`,
    ).toEqual([]);

    // And the connection is not merely open but still serving, which is what the suite's pooled contexts need.
    get();
    await until(() => received.length > afterFirst, 20_000, "the reused connection should answer");
    expect(received.slice(afterFirst), "the second request, on the same socket as the first").toContain(
      "HTTP/1.1 200",
    );
  } finally {
    // The client is the side that closes, which is the whole point of the fix.
    socket.destroy();
  }
});
