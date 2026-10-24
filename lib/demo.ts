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
//                      can be attributed to a demo practice carries `demo: true` (markDemoPractice in
//                      lib/log.ts), and the alarm's metric filter leaves those lines out —
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
// No imports, for the same reason lib/retention.ts and lib/suppression.ts have none: the dashboard is a
// client component and reads DEMO_BLOCKED below to say why a message did not go, so anything this module
// pulled in would land in the browser bundle — and lib/log.ts, which the labelling half needs, is built on
// node:async_hooks. So the label lives in lib/log.ts (`markDemoPractice`) and the rules live here, where
// lib/demo.test.ts can state them without a Postgres or a browser.

/** What `Practice.isDemo` looks like to a caller that has only loaded the one column. */
export type DemoFacts = { isDemo: boolean } | null | undefined;

export const isDemoPractice = (practice: DemoFacts): boolean => Boolean(practice?.isDemo);

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

/**
 * §13.4's rule as a clause rather than a sentence, so a screen asking *before* a send can say it too (T145).
 *
 * `DEMO_BLOCKED` below is the report: it is written to a `VisitDelivery.error` once the send did not happen,
 * so it opens with "not sent:". The booking wizard asks the same question two screens earlier — step 3's
 * forecast and the success card's `reason` — where that prefix would stutter against the sentence it is
 * dropped into ("No invite sent: not sent: …"). So the words are written once, here, and the tense belongs
 * to whoever is speaking: the same shape as `HAND_IT_OVER` in lib/booking.ts, which two branches say in two
 * positions in their sentence.
 *
 * No address in it, like every other reason in this family: it reaches staff's screen and the log (§10.3).
 */
export const DEMO_ONLY_TEST_ADDRESSES = "a demo practice only messages reserved test addresses (design §13.4)";

/** Why a demo practice did not send on this channel. One sentence, no address in it: it is written to a
 *  `VisitDelivery.error` staff read on the dashboard (§8.3) and to the log (§10.3). The dashboard compares
 *  against this constant rather than matching on words, which is why it is exported. */
export const DEMO_BLOCKED = `not sent: ${DEMO_ONLY_TEST_ADDRESSES}`;

/** What the dashboard prints under the pill when that is the reason (app/provider/dashboard.tsx). Shorter,
 *  and in the practice's own terms: staff looking at a demo row want to know the app is working. */
export const DEMO_BLOCKED_LABEL = "Demo practice: only test addresses are messaged";

/** Was this delivery the one above? Compared on the constant, so the wording can change in one place. */
export const isDemoBlocked = (error: string | null | undefined): boolean => error === DEMO_BLOCKED;

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
