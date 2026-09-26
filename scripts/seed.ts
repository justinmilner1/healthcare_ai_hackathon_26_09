// npm run seed: demo provider + patient with the sample files already uploaded. Prints the three URLs.
// Safe to re-run; it creates a fresh patient each time.

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { parseClarityCsv } from "../lib/glucose";
import { parseTimeline, parseVisitsCsv } from "../lib/location";
import { parseWhoopCsv } from "../lib/sleep";

const db = new PrismaClient();
const data = (f: string) => readFileSync(join(process.cwd(), "data", f), "utf8");

async function main() {
  const provider = await db.provider.upsert({
    where: { email: "demo@sweetspot.local" },
    update: {},
    create: { name: "Dr. Demo Endo", email: "demo@sweetspot.local", practice: "Sweet Spot Endocrinology" },
  });
  const token = randomBytes(16).toString("base64url");
  const patient = await db.patient.create({
    data: { name: "Sam Sample", phone: "+14155550100", providerId: provider.id, optIn: true, token, apptAt: new Date(Date.now() + 2 * 86400000) },
  });

  const files: [string, string, unknown[]][] = [
    ["dexcom", "dexcom_clarity_sample.csv", parseClarityCsv(data("dexcom_clarity_sample.csv"))],
    ["timeline", "timeline_sample.json", parseTimeline(data("timeline_sample.json"))],
    ["visits", "visits.csv", parseVisitsCsv(data("visits.csv"))],
    ["whoop", "whoop_sample.csv", parseWhoopCsv(data("whoop_sample.csv"))],
  ];
  for (const [kind, filename, parsed] of files) {
    await db.upload.create({ data: { patientId: patient.id, kind, filename, raw: data(filename), parsed: JSON.stringify(parsed) } });
    console.log(`${kind}: ${parsed.length} rows`);
  }

  const base = process.env.APP_URL ?? "http://localhost:3000";
  console.log(`\nSweetie (patient chat):  ${base}/s/${token}`);
  console.log(`Sour (provider view):    ${base}/provider/${provider.id}`);
  console.log(`Patient summary:         ${base}/patient/${patient.id}`);
}

main().finally(() => db.$disconnect());
