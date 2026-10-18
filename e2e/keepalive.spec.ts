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

  /** How many requests this socket has had answered, counted by status line.
   *
   *  Not by byte offset, which is what this test used to do and what made it fail on a server that had
   *  done nothing wrong. `/api/health/live` answers with `Transfer-Encoding: chunked`, so its headers and
   *  its body (`b\r\n{"ok":true}\r\n0\r\n\r\n`) can arrive in separate packets. Recording
   *  `received.length` the moment the first `\r\n\r\n` landed therefore recorded the *middle* of the
   *  first response, and those trailing body bytes satisfied "more has arrived than before" on their own,
   *  before the second request had been answered at all — so the assertion read the tail of response one
   *  and reported it as a missing 200. Counting status lines does not care how the bytes are framed or how
   *  the kernel splits them. */
  const answers = () => received.match(/HTTP\/1\.1 200/g)?.length ?? 0;

  try {
    await until(() => socket.readyState === "open", 10_000, "the socket should connect");
    get();
    await until(() => answers() >= 1, 20_000, "the server should answer the first request");
    expect(received, "liveness should answer 200, and keep the connection").toContain("HTTP/1.1 200");

    // The gap. Without the flag in playwright.config.ts the server sends FIN in the middle of this.
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    expect(
      closedBy,
      `the server closed an idle connection after ${IDLE_MS}ms; raise --keepAliveTimeout in playwright.config.ts`,
    ).toEqual([]);

    // And the connection is not merely open but still serving, which is what the suite's pooled contexts need.
    get();
    await until(() => answers() >= 2 || closedBy.length > 0, 20_000, "the reused connection should answer");
    expect(closedBy, "the server hung up on the reused connection rather than answering it").toEqual([]);
    expect(answers(), "the second request, on the same socket as the first, should answer 200 too").toBeGreaterThanOrEqual(2);
  } finally {
    // The client is the side that closes, which is the whole point of the fix.
    socket.destroy();
  }
});
