// Dependency audit rules (design §10.8, §12.4). Owner: compliance.
//
// The pure half of the audit gate: parse an `npm audit --json` report, and decide which advisories are
// allowed to be there. scripts/audit.ts is the shell that runs npm, reads security/audit-exceptions.json,
// prints, and sets the exit code. docs/SECURITY.md is the process the exception file implements.
//
// No imports: these functions take a parsed report and a list of exceptions and return a verdict, so the
// decisions can be tested without a registry (lib/audit.test.ts).

/** Severities that fail the build. Matches `npm audit --audit-level=high`. */
export const GATED_SEVERITIES: readonly string[] = ["high", "critical"];

/** One row of security/audit-exceptions.json. Every field is required; see assertExceptions. */
export type AuditException = {
  /** npm's numeric advisory id, the stable key across package versions. */
  advisory: number;
  package: string;
  url?: string;
  /** Where in the tree it sits, in words: "devDependency, via prisma -> @prisma/config". */
  scope?: string;
  reason: string;
  owner: string;
  /** ISO date. Past it, the gate fails until someone re-assesses. */
  expires: string;
};

/** One advisory in the tree, with the packages it was reported on. */
export type Advisory = {
  source: number;
  package: string;
  title: string;
  url: string;
  severity: string;
  paths: string[];
};

type AuditVia = { source?: number; name?: string; title?: string; url?: string; severity?: string };
type AuditVulnerability = { severity?: string; via?: (string | AuditVia)[]; nodes?: string[] };
export type AuditReport = { vulnerabilities?: Record<string, AuditVulnerability>; error?: unknown };

/**
 * Every distinct gated advisory in the report.
 *
 * npm lists a vulnerability for each package in the chain, so one advisory appears many times: the package
 * that actually has the flaw carries it as an object in `via`, and everything that merely depends on that
 * package carries the dependency's *name* as a string. Only the objects are advisories; the strings would
 * double-count. Paths from every entry carrying the same advisory id are merged, which is what makes the
 * printed report say where it is.
 */
export function advisoriesOf(report: AuditReport): Advisory[] {
  const byId = new Map<number, Advisory>();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "string") continue;
      if (!via.source || !GATED_SEVERITIES.includes(String(via.severity))) continue;
      const found = byId.get(via.source);
      if (found) {
        found.paths = [...new Set([...found.paths, ...(vuln.nodes ?? [])])];
        continue;
      }
      byId.set(via.source, {
        source: via.source,
        package: via.name ?? name,
        title: via.title ?? "(no title)",
        url: via.url ?? "",
        severity: String(via.severity),
        paths: [...(vuln.nodes ?? [])],
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.package.localeCompare(b.package) || a.source - b.source);
}

/** Throws on an exception that is missing a field the process requires. A half-filled exception is how a
 *  "temporary" one becomes permanent: with no owner nobody is asked, with no expiry nobody is asked twice. */
export function assertExceptions(list: readonly AuditException[]): void {
  const required = ["advisory", "package", "reason", "owner", "expires"] as const;
  for (const e of list) {
    for (const field of required) {
      const value = e[field];
      if (value === undefined || value === null || value === "") {
        throw new Error(`audit exception ${e.advisory ?? "(no advisory id)"} is missing "${field}"`);
      }
    }
    if (typeof e.advisory !== "number" || !Number.isInteger(e.advisory)) {
      throw new Error(`audit exception for ${e.package} has a non-numeric "advisory"`);
    }
    if (Number.isNaN(Date.parse(e.expires))) {
      throw new Error(`audit exception ${e.advisory} has an unparsable "expires" (${e.expires})`);
    }
  }
}

export type Verdict = {
  /** Gated advisories covered by an exception that has not expired. */
  allowed: { advisory: Advisory; exception: AuditException }[];
  /** Gated advisories with no live exception. Any of these fails the build. */
  blocking: Advisory[];
  /** Exceptions whose date has passed. Fails the build, so re-assessment is not optional. */
  expired: AuditException[];
  /** Live exceptions that match nothing: fixed upstream. A warning, not a failure. */
  stale: AuditException[];
};

/** Who is allowed to be here, who is not, and which exceptions have stopped being true. */
export function classify(advisories: readonly Advisory[], exceptions: readonly AuditException[], now: Date = new Date()): Verdict {
  assertExceptions(exceptions);
  const at = now.getTime();
  const live = new Map<number, AuditException>();
  const expired: AuditException[] = [];
  for (const e of exceptions) {
    if (Date.parse(e.expires) < at) expired.push(e);
    else live.set(e.advisory, e);
  }

  const allowed: Verdict["allowed"] = [];
  const blocking: Advisory[] = [];
  for (const advisory of advisories) {
    const exception = live.get(advisory.source);
    if (exception) allowed.push({ advisory, exception });
    else blocking.push(advisory);
  }

  const present = new Set(advisories.map((a) => a.source));
  const stale = [...live.values()].filter((e) => !present.has(e.advisory));
  return { allowed, blocking, expired, stale };
}

/** True when the audit should fail the build. */
export function failed(verdict: Verdict): boolean {
  return verdict.blocking.length > 0 || verdict.expired.length > 0;
}
