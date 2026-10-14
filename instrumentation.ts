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
// The import is dynamic so lib/ is not *evaluated* in the edge runtime — but it is still bundled there.
// Webpack traces a dynamic import whether or not a guard above it means the import never runs, so since T27
// added middleware.ts (which is what makes Next compile this file for edge at all), everything reachable from
// lib/config.ts has to be edge-safe. That is why lib/log.ts uses the Web Crypto global rather than
// node:crypto; without it the production build fails with an unhandled `node:` scheme.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
