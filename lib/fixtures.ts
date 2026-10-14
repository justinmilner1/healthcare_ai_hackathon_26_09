// Test support, not application code: the one way lib/*.test.ts reads data/fixtures/ (design §9.4).
// Nothing under app/ imports this; it touches the filesystem and would never run in a request.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The Clarity and WHOOP fixtures carry device-local timestamps with no offset, as the real exports do, so a test
 *  that asserts on an instant or a calendar day pins the zone first. See data/fixtures/README.md. */
export function pinUtcTimeZone(): void {
  process.env.TZ = "UTC";
}
