// Test support, not application code: how lib/*.test.ts reads data/fixtures/ (design §9.4) and how the
// database-backed suites get a throwaway schema to work in.
// Nothing under app/ imports this; it touches the filesystem and would never run in a request.
//
// No lib/fixtures.test.ts, and the one module `npm run test:coverage` excludes by name
// (--test-coverage-exclude in package.json, design §12.1): it is the harness the other suites run on, so
// every line of it is already executed by them and a coverage row for it would measure the measuring.
// A bug in here fails the suite that uses it, loudly, which is the test.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

export const FIXTURE_DIR = join(process.cwd(), "data", "fixtures");

export type FixtureName =
  | "clarity_window.csv"
  | "clarity_sustained_high.csv"
  | "clarity_edge_cases.csv"
  | "timeline_android.json"
  | "timeline_ios.json"
  | "visits.csv"
  | "visit_import.csv"
  | "whoop_cycles.csv"
  | "whoop_alt_headers.csv";

/** Read a fixture verbatim. Fails loudly: a renamed fixture should break the test, not silently empty it. */
export function fixture(name: FixtureName): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** The week-long demo files one folder up (`data/*`), which `npm run seed` loads into the demo visit — not
 *  parser fixtures, and listed separately so the two cannot be confused: `data/visits.csv` and
 *  `data/fixtures/visits.csv` share a basename and are different files. */
export type SampleName = "dexcom_clarity_sample.csv" | "timeline_sample.json" | "visits.csv" | "whoop_sample.csv";

/**
 * Read one of the demo samples verbatim, for the one thing that has to be asserted about them rather than
 * about a fixture: the seeded follow-up answer is derived from these two exports and is wrong the moment they
 * change under it (T112, lib/seedFollowUp.test.ts). Fails loudly, like `fixture`.
 */
export function sample(name: SampleName): string {
  return readFileSync(join(process.cwd(), "data", name), "utf8");
}

/** The Clarity and WHOOP fixtures carry device-local timestamps with no offset, as the real exports do, so a test
 *  that asserts on an instant or a calendar day pins the zone first. See data/fixtures/README.md. */
export function pinUtcTimeZone(): void {
  process.env.TZ = "UTC";
}

// ---------------------------------------------------------------------------------------------
// A throwaway database schema

/** The Postgres *server* the suites build their fixture schemas on, or undefined, in which case they skip
 *  (design §3.2; `npm test` still has to run on a laptop with no database up). */
export const FIXTURE_SERVER_URL = process.env.DATABASE_URL;

/** Why a database-backed `describe` is skipped, in the shape `node:test`'s `skip` option wants. */
export const SKIP_WITHOUT_DB = FIXTURE_SERVER_URL ? false : "DATABASE_URL is not set";

export type FixtureSchema = {
  /** The schema's own connection string. */
  url: string;
  /** The schema name, for raw SQL. */
  schema: string;
  /** A client pointed at the schema, for building rows and reading them back. */
  db: PrismaClient;
  /** Drop the schema, disconnect, and put `process.env.DATABASE_URL` back if it was repointed. */
  drop: () => Promise<void>;
};

/**
 * A throwaway schema in whatever server `DATABASE_URL` points at, migrated with `prisma migrate deploy` and
 * dropped by the returned `drop`. That is cheaper than a second server and it exercises the same migrations
 * the app runs. The pattern lib/jobs.test.ts and lib/migrateVisits.test.ts established, in one place now that
 * T42 gives six more suites a database.
 *
 * `useAsDefault` additionally repoints `process.env.DATABASE_URL` at the new schema, which is how a suite
 * tests a module that reads the `db` singleton out of lib/db.ts instead of taking a client: Prisma resolves
 * the URL when the client is *constructed*, so such a module has to be pulled in with `await import(...)`
 * after this call and must not be imported statically anywhere in the file.
 */
export async function fixtureSchema(prefix: string, opts: { useAsDefault?: boolean } = {}): Promise<FixtureSchema> {
  if (!FIXTURE_SERVER_URL) throw new Error("fixtureSchema needs DATABASE_URL; guard the describe with SKIP_WITHOUT_DB");
  const schema = `${prefix}_${randomBytes(4).toString("hex")}`;
  const parsed = new URL(FIXTURE_SERVER_URL);
  parsed.searchParams.set("schema", schema);
  const url = parsed.toString();

  const admin = new PrismaClient({ datasourceUrl: FIXTURE_SERVER_URL });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  } catch (e) {
    // Without this the failure reads "Command failed", which says nothing about which migration broke.
    const out = e as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
  }

  const previousUrl = process.env.DATABASE_URL;
  if (opts.useAsDefault) process.env.DATABASE_URL = url;
  const db = new PrismaClient({ datasourceUrl: url });

  return {
    url,
    schema,
    db,
    drop: async () => {
      if (opts.useAsDefault) process.env.DATABASE_URL = previousUrl;
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}
