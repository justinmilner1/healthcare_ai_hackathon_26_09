// The minute tick for the job queue (design §3.4). Owner: platform.
//
// EventBridge Scheduler can only call AWS APIs, and `POST /api/jobs/run` is an HTTPS route on the app, so this
// is the smallest thing that bridges the two: read the shared secret out of SSM Parameter Store (§10.6), POST,
// and let the response speak for itself. No dependencies and no bundler — the Node 22 runtime has `fetch`, and
// the SSM call is a signed GET made with the runtime's own credentials provider via the AWS SDK that ships in
// the runtime image.
//
// It deliberately knows nothing about jobs. The queue, the retries and the three-attempt limit are in
// lib/jobs.ts; the only decision made here is whether the call happened at all, which is what the
// `jobs-tick-errors` alarm watches.

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({});
let cachedSecret = null;

async function jobsSecret() {
  // The container outlives a tick, so the parameter is fetched once per cold start rather than once a minute.
  // A rotated secret therefore takes effect on the next cold start or within the minute after a 401 below.
  if (cachedSecret) return cachedSecret;
  const name = process.env.JOBS_SECRET_PARAMETER;
  if (!name) throw new Error("JOBS_SECRET_PARAMETER is not set");
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter && out.Parameter.Value;
  if (!value) throw new Error(`${name} is empty: put the JOBS_SECRET SecureString in place (docs/DEPLOY.md)`);
  cachedSecret = value;
  return value;
}

exports.handler = async function handler() {
  const url = process.env.JOBS_URL;
  if (!url) throw new Error("JOBS_URL is not set");

  const call = async (secret) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(50_000), // under the function's own 60s timeout, so the error is this one
    });

  let res = await call(await jobsSecret());
  if (res.status === 401 || res.status === 403) {
    // The secret was rotated under us. Drop the cache and try once with a fresh read before giving up, so a
    // rotation costs one failed tick at most instead of one per container.
    cachedSecret = null;
    res = await call(await jobsSecret());
  }

  const body = await res.text();
  if (!res.ok) {
    // Thrown, not logged and swallowed: a tick that cannot reach the runner has to show up as a Lambda error,
    // because that is the metric the alarm reads. The body is the app's own JSON error, which carries no PHI
    // (§10.3), and is capped in case something upstream answered with a page.
    throw new Error(`POST ${url} -> ${res.status} ${body.slice(0, 500)}`);
  }
  // The drain report, straight through: claimed/done/failed counts. Lands in this function's log group.
  return { status: res.status, report: body.slice(0, 1000) };
};
