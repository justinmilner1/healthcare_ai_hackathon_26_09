// Demo practices (design §13.4). Owner: ops.
//
// §13.4 in full: "a flag on a practice that marks it synthetic; demo practices are excluded from retention
// sweeps and alarms and are never emailed real addresses." The flag is `Practice.isDemo`; this module is the
// three exclusions, and it is where each of them is written down once:
//
//   retention sweeps   lib/retentionStore.ts leaves a demo practice's visits alone, so the week of readings
//                      a salesperson walks a prospect through is still there next month. A staff deletion
//                      (§10.5) still works — that is somebody pressing a button, not a clock.
//   alarms             §11.1's alarms read the JSON log lines as metrics. There is nothing in CloudWatch an
//                      application can exclude itself from, so the exclusion is a *label*: every line that
//                      can be attributed to a demo practice carries `demo: true` (noteDemo below, via
//                      lib/log.ts markDemo), and the alarm's metric filter leaves those lines out —
//                      docs/LOGGING.md has the filter. A demo visit whose Sour run fails wakes nobody.
//   real addresses     Everything the product sends goes out through lib/notify.ts and lib/mailer.ts. From a
//                      demo practice those take the gate below, and a destination that is not provably
//                      synthetic is not sent to at all.
//
// The address rule is an allow-list rather than a block-list, because the failure it exists to stop is one
// nobody can take back: a seeded practice, a demo visit booked against a prospect's own mobile number, and a
// patient who never asked for any of it gets a text about an appointment they do not have. So a demo
// practice may message the reserved names and numbers that cannot belong to anyone (RFC 2606 and RFC 6761
// for the domains, the NANP's 555-01xx range for the phones) and nothing else. Being wrong in this direction
// means a demo that shows "skipped: a demo practice does not message real addresses" on the dashboard, which
// is a sentence a salesperson can explain.
//
// Pure, and importable from anywhere: the rules are worth asserting without a Postgres (lib/demo.test.ts),
// and the only thing in here that is not a predicate is noteDemo, which calls into lib/log.ts.

import { markDemo } from "./log";

/** What `Practice.isDemo` looks like to a caller that has only loaded the one column. */
export type DemoFacts = { isDemo: boolean } | null | undefined;

export const isDemoPractice = (practice: DemoFacts): boolean => Boolean(practice?.isDemo);

/**
 * Label every log line from here on in this request or job with `demo: true`, if this practice is a demo one.
 *
 * Called from the places that have a practice in hand anyway — lib/visit.ts, which every patient route and
 * every visit-shaped job goes through, and the job handlers for the two jobs that have no visit. One call
 * covers a whole request, including the `request_failed` and `job_failed` lines §11.1's alarms read, because
 * the flag rides the request context rather than the call site (lib/log.ts).
 */
export function noteDemo(practice: DemoFacts): boolean {
  if (!isDemoPractice(practice)) return false;
  markDemo();
  return true;
}

// ---------------------------------------------------------------------------------------------
// §13.4 "never emailed real addresses"

/** Top-level domains reserved by RFC 2606 and RFC 6761: no registry will ever sell one, so no message to one
 *  can reach a person who did not set it up themselves. `localhost` is in RFC 6761 for the same reason. */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);

/** The second-level names RFC 2606 reserves for documentation. A subdomain of one is reserved with it. */
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/**
 * Is this address one that cannot belong to a real person?
 *
 * `.local` is in the list beside the RFC names. It is mDNS's rather than a reserved TLD, so it is not quite
 * the same promise — but it is not delegated by the root either, which is the property that matters here, and
 * it is what this repo's own synthetic data has always used (`demo@sweetspot.local`, `sam.sample@…`).
 */
export function isSyntheticEmail(address: string | null | undefined): boolean {
  if (typeof address !== "string") return false;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return false;
  const tld = domain.split(".").pop() ?? "";
  if (RESERVED_TLDS.has(domain) || RESERVED_TLDS.has(tld)) return true;
  return RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`));
}

/**
 * Is this a number from the fictitious range?
 *
 * The NANP reserves 555-0100 through 555-0199 in every area code for fiction, which is where this repo's
 * sample numbers come from (`+1 415 555 0100`). Anything else — including the rest of the 555 prefix, which
 * is assignable — is treated as somebody's phone.
 */
export function isSyntheticPhone(number: string | null | undefined): boolean {
  if (typeof number !== "string") return false;
  const digits = number.replace(/\D+/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return false;
  return /^[2-9]\d{2}55501\d{2}$/.test(national);
}

/** Why a demo practice did not send on this channel. One sentence, no address in it: it is written to a
 *  `VisitDelivery.error` staff read on the dashboard (§8.3) and to the log (§10.3). */
export const DEMO_BLOCKED = "not sent: a demo practice only messages reserved test addresses (design §13.4)";

/**
 * The gate every send goes through from a demo practice: the reason it must not go out, or null when the
 * destination is synthetic and it may.
 *
 * `demo` false — nearly every practice — is null without looking at the destination at all, so a real
 * practice's sends are untouched by any of this.
 */
export function demoBlockReason(demo: boolean, channel: "sms" | "email", to: string | null | undefined): string | null {
  if (!demo) return null;
  const synthetic = channel === "email" ? isSyntheticEmail(to) : isSyntheticPhone(to);
  return synthetic ? null : DEMO_BLOCKED;
}
