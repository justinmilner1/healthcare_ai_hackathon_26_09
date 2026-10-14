// Next.js calls register() once per server process, before the first request is served. That makes it the
// place the §3.7 config gate belongs: a production deployment missing something required never answers at all,
// rather than answering wrongly.
//
// Two guards keep it from firing where it would only be noise:
//
//   NEXT_RUNTIME  register() also runs in the edge runtime, which has no process environment worth checking
//                 and cannot load lib/log.ts. The node server is the one that talks to Postgres and the model.
//   NEXT_PHASE    `next build` runs with NODE_ENV=production but is not a running deployment, and a build
//                 machine legitimately has no database URL or API key. Validating there would turn every
//                 build without production secrets into a failure, so the gate waits for the server.
//
// **The shape of the NEXT_RUNTIME guard is load-bearing, not style.** Next compiles this file once per
// runtime and replaces `process.env.NEXT_RUNTIME` with a literal in each, so in the edge compilation the
// condition below is `"edge" === "nodejs"`. Webpack folds that to false while it is parsing and never walks
// the branch, so the `import("./lib/config")` inside it is never added to the edge module graph. Written as
// an early return — `if (process.env.NEXT_RUNTIME !== "nodejs") return;` with the import after it — the
// import sits in code webpack does walk, and lib/config.ts drags lib/log.ts and its `node:crypto` and
// `node:async_hooks` imports into an edge bundle that cannot have them:
//
//     Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins
//     Import trace: node:crypto -> ./lib/log.ts -> ./lib/config.ts
//
// That build failure needs both an instrumentation file and a middleware file to appear, because the edge
// compilation of this file is what middleware.ts brings into existence — which is why T31 and T27 each
// passed on their own branch and `main` went red the moment both had merged (T46).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if ((process.env.NEXT_PHASE ?? "").includes("build")) return;

    const { ConfigError, assertConfig } = await import("./lib/config");
    try {
      assertConfig();
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // Left to itself, Next logs a failed instrumentation hook and then keeps the server up, answering 500 to
      // every request — a deployment that looks alive, stays in service, and serves nothing. Exiting non-zero is
      // what "refuses to start" has to mean to whatever supervises the process: the deploy fails and rolls back
      // (design §13.3) instead of taking traffic. The list goes to stderr unformatted because an operator
      // reading a crashed container wants it whole, not one JSON line per problem.
      process.stderr.write(`\n${e.message}\n\n`);
      process.exit(1);
    }
  }
}
