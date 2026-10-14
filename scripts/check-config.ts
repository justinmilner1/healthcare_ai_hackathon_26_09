// npm run config:check — the §3.7 gate as a command, so a deploy can run it before it swings traffic over
// (design §13.3) and a developer can see what the app thinks of their .env without starting a server.
//
// Prints every variable in lib/config.ts SPEC with whether it is set — never with its value — then the
// problems. Exits 1 if any problem is fatal in the environment being judged.
//
//   npm run config:check                 judge the current environment (NODE_ENV decides the strictness)
//   npm run config:check -- --production judge it as a production deployment would, from a dev shell

import { config as loadEnv } from "dotenv";
import { GROUPS, SPEC, formatProblems, isProduction, read, validateConfig } from "../lib/config";

loadEnv();

const asProduction = process.argv.includes("--production") || isProduction();
const problems = validateConfig(process.env, { production: asProduction });
const errors = problems.filter((p) => p.level === "error");
const warnings = problems.filter((p) => p.level === "warning");

const MARK = { required: "!", recommended: "+", optional: " " } as const;
const width = Math.max(...SPEC.map((s) => s.name.length));

console.log(`Sweet Spot configuration — judged as ${asProduction ? "production" : "development"}\n`);
for (const group of GROUPS) {
  console.log(group);
  for (const spec of SPEC.filter((s) => s.group === group)) {
    const state = read(process.env, spec.name) === undefined ? "unset" : "set";
    console.log(`  ${MARK[spec.requirement]} ${spec.name.padEnd(width)}  ${state.padEnd(5)}  ${spec.summary}`);
  }
  console.log("");
}
console.log("! required   + recommended   (blank) optional\n");

if (errors.length > 0) console.log(`${errors.length} problem${errors.length > 1 ? "s" : ""} that stop${errors.length > 1 ? "" : "s"} the app from starting:\n${formatProblems(errors)}\n`);
if (warnings.length > 0) console.log(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}:\n${formatProblems(warnings)}\n`);
if (problems.length === 0) console.log("No problems.\n");

process.exit(errors.length > 0 ? 1 : 0);
