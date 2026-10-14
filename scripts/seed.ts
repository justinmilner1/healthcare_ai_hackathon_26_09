// npm run seed: demo practice, provider, and a patient with one visit (design §4.4) whose sample files are
// already uploaded. Prints the three URLs. Safe to re-run; it creates a fresh patient each time.

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { appUrl } from "../lib/config";
import { db } from "../lib/db";
import { parseClarityCsv } from "../lib/glucose";
import { parseTimeline, parseVisitsCsv } from "../lib/location";
import { upsertProvider } from "../lib/practice";
import { parseWhoopCsv } from "../lib/sleep";

const data = (f: string) => readFileSync(join(process.cwd(), "data", f), "utf8");

async function main() {
  const provider = await upsertProvider({ name: "Dr. Demo Endo", email: "demo@sweetspot.local", practice: "Sweet Spot Endocrinology" });
  const token = randomBytes(16).toString("base64url");
  const visit = await db.visit.create({
    data: {
      providerUser: { connect: { id: provider.id } },
      optIn: true,
      token,
      scheduledAt: new Date(Date.now() + 2 * 86400000),
      patient: { create: { practiceId: provider.practiceId, name: "Sam Sample", phone: "+14155550100" } },
    },
  });

  const files: [string, string, unknown[]][] = [
    ["dexcom", "dexcom_clarity_sample.csv", parseClarityCsv(data("dexcom_clarity_sample.csv"))],
    ["timeline", "timeline_sample.json", parseTimeline(data("timeline_sample.json"))],
    ["visits", "visits.csv", parseVisitsCsv(data("visits.csv"))],
    ["whoop", "whoop_sample.csv", parseWhoopCsv(data("whoop_sample.csv"))],
  ];
  for (const [kind, filename, parsed] of files) {
    const raw = data(filename);
    await db.upload.create({
      data: { visitId: visit.id, kind, filename, bytes: raw.length, parsedRows: parsed.length, data: { create: { parsed: JSON.stringify(parsed), raw } } },
    });
    console.log(`${kind}: ${parsed.length} rows`);
  }

  const base = appUrl();
  console.log(`\nSweetie (patient chat):  ${base}/s/${token}`);
  console.log(`Sour (provider view):    ${base}/provider/${provider.id}`);
  console.log(`Patient summary:         ${base}/patient/${token}`);
  // The provider pages are behind sign-in now (design §5.1); the patient links above are not.
  console.log(`\nSign in as ${provider.email} at ${base}/provider, then \`npm run mail\` for the link.`);
}

main().finally(() => db.$disconnect());
