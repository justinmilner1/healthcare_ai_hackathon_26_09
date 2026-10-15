// Dependency audit gate (design §10.8, §12.4). Owner: compliance. Run: npm run audit:deps
//
// Runs `npm audit --audit-level=high` and fails on anything high or critical that is not written down in
// security/audit-exceptions.json. The rules are in lib/audit.ts; this file is the shell around them.
//
// Why a wrapper and not the bare command: npm audit is all or nothing. One advisory with no published fix —
// today, postcss, which every Next.js release depends on — makes the bare command red forever, and a check
// that is always red is a check nobody reads. Subtracting a written-down list keeps the gate meaningful: a
// new advisory is still a red build on the pull request that introduced it, and an exception stops working
// on the date its owner agreed to look again. docs/SECURITY.md is the process.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { advisoriesOf, classify, failed, type AuditException, type AuditReport } from "../lib/audit";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXCEPTIONS_FILE = join(ROOT, "security", "audit-exceptions.json");
// Which package tree to audit. The app is the default; `npm run audit:deps -- infra` audits the CDK app
// (design §3.6), which is a second package.json and so a second tree npm audit never sees from here. One
// exceptions file either way: §10.8's list is about this repository, not about one of its directories.
const TREE = join(ROOT, process.argv[2] ?? ".");

/** `npm audit --json` writes its report to stdout and exits non-zero when it found something, so a non-zero
 *  exit is not an error here. No parsable report is: that is the registry being out of reach. */
function runAudit(): { report: AuditReport } | { unreachable: string } {
  let stdout = "";
  try {
    stdout = execFileSync("npm", ["audit", "--json", "--audit-level=high"], { cwd: TREE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    stdout = err.stdout ?? "";
    if (!stdout.trim()) return { unreachable: err.message ?? "npm audit produced no output" };
  }
  let report: AuditReport;
  try {
    report = JSON.parse(stdout) as AuditReport;
  } catch {
    return { unreachable: "npm audit did not return JSON" };
  }
  if (report.error) return { unreachable: `npm audit reported an error: ${JSON.stringify(report.error).slice(0, 300)}` };
  return { report };
}

function readExceptions(): AuditException[] {
  const parsed = JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8")) as { exceptions?: AuditException[] };
  return parsed.exceptions ?? [];
}

function main(): void {
  const result = runAudit();
  if ("unreachable" in result) {
    // The registry is half of the audit. CI always has it, so failing to reach it there is a failure. On a
    // developer's machine, or in a sandbox with the registry firewalled off, it is not worth blocking the
    // rest of scripts/agent-check.sh over.
    const message = `dependency audit could not run: ${result.unreachable}`;
    if (process.env.CI) {
      console.error(`FAIL  ${message}`);
      process.exit(1);
    }
    console.warn(`SKIP  ${message} (not CI; CI treats this as a failure)`);
    return;
  }

  const advisories = advisoriesOf(result.report);
  const verdict = classify(advisories, readExceptions());

  console.log(`dependency audit (${TREE === ROOT ? "app" : process.argv[2]}): ${advisories.length} advisory(ies) at high or above, ${verdict.allowed.length} with a documented exception`);
  for (const { advisory, exception } of verdict.allowed) {
    console.log(`  ALLOWED  ${advisory.package} ${advisory.severity} #${advisory.source}  until ${exception.expires} (${exception.owner})  ${advisory.title.slice(0, 80)}`);
  }
  for (const a of verdict.blocking) {
    console.error(`  BLOCKING ${a.package} ${a.severity} #${a.source}  ${a.url}`);
    console.error(`           ${a.title}`);
    console.error(`           in ${a.paths.slice(0, 4).join(", ") || "(path not reported)"}`);
  }
  // Only when auditing the app. The exceptions file covers the whole repository, so an entry that matches
  // nothing in the CDK tree is almost certainly doing its job in the app tree, and calling it stale here
  // would be an instruction to delete a live exception.
  if (TREE === ROOT) {
    for (const e of verdict.stale) {
      console.warn(`  STALE    exception for ${e.package} #${e.advisory} matches nothing; remove it from security/audit-exceptions.json`);
    }
  }
  for (const e of verdict.expired) {
    console.error(`  EXPIRED  exception for ${e.package} #${e.advisory} ran out on ${e.expires}; ${e.owner} must re-assess it (docs/SECURITY.md)`);
  }

  if (failed(verdict)) {
    if (verdict.blocking.length) {
      console.error(`FAIL  ${verdict.blocking.length} advisory(ies) at high or above with no documented exception. Upgrade the dependency, or follow docs/SECURITY.md to record an exception.`);
    }
    if (verdict.expired.length) console.error(`FAIL  ${verdict.expired.length} expired exception(s).`);
    process.exit(1);
  }
  console.log("dependency audit: pass");
}

main();
