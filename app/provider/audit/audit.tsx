"use client";

// The audit trail screen (design §4.8, §10.2). Rendered by page.tsx, which is the server component that
// checks the session and the admin role. Every row comes from GET /api/audit, scoped to this practice by the
// session, so there is no practice id in this file to get wrong.
//
// Only the pure half of the audit module is imported here: this is a client component, and lib/auditStore.ts
// would drag Prisma into the browser bundle (lib/auditLog.ts says more about why that matters).
//
// What a row shows is deliberately thin. §4.8 keeps PHI out of `detail`, and nothing on this screen puts it
// back: the actor is a colleague, which an admin already sees in settings, and the thing acted on is an
// opaque id with a link to the visit for an admin who wants to know whose it was. The audit log answers "who
// touched this", not "what did it say".

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import { actionLabel, AUDIT_ACTION_NAMES, AUDIT_LIMITS, DEFAULT_AUDIT_LIMIT, type AuditEntry } from "@/lib/auditLog";

type Listing = { entries: AuditEntry[]; total: number; actors: { id: string; label: string }[] };

const BLANK = { action: "", actorId: "", entityId: "", from: "", to: "", limit: String(DEFAULT_AUDIT_LIMIT) };
type Filters = typeof BLANK;

/** The filter form as a query string, leaving out what was not filled in. */
function queryOf(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}

/** A cuid is 25 characters of nothing in particular, so the table shows the first eight and the title holds
 *  the rest — enough to recognise a row you were already looking for, short enough to keep the columns. */
const shortId = (id: string) => `${id.slice(0, 8)}…`;

const when = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
};

export default function AuditTrail({ meId }: { meId: string }) {
  const [filters, setFilters] = useState<Filters>(BLANK);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const query = useMemo(() => queryOf(filters), [filters]);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/audit?${search}`);
      if (response.status === 401) {
        window.location.href = "/provider/signin";
        return;
      }
      // A 403 means the role changed under us — another admin demoted this account while the page was open.
      if (response.status === 403) {
        window.location.href = "/provider";
        return;
      }
      if (!response.ok) throw new Error("The audit log could not be read. Try again.");
      setListing((await response.json()) as Listing);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The audit log could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(query);
  }, [load, query]);

  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));
  const filtered = query !== queryOf(BLANK);
  const entries = listing?.entries ?? [];

  return (
    <main className="ss-page sour-theme provider-dashboard">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Audit trail" />
          <div className="provider-top-actions">
            <Link href="/provider/settings" className="ss-button">
              Settings
            </Link>
            <Link href="/provider" className="ss-button">
              ← Dashboard
            </Link>
            <Link href="/provider/signout" className="ss-text-button">
              Sign out
            </Link>
          </div>
        </header>

        <section className="provider-section-head settings-head">
          <div>
            <p className="ss-eyebrow">AUDIT TRAIL</p>
            <h1 className="ss-title">Who touched what.</h1>
            <p className="ss-lede">
              Every read of a visit&apos;s answers, chat, uploads or summary; every patient link accepted; every
              message sent; every deletion. Admins only. Entries are never edited or removed, and carry no
              patient details — only who, what, and when.
            </p>
          </div>
        </section>

        <form className="ss-card audit-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter the audit trail">
          <label className="ss-label" htmlFor="audit-action">
            <span>Action</span>
            <select id="audit-action" className="ss-input" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
              <option value="">Any action</option>
              {AUDIT_ACTION_NAMES.map((action) => (
                <option key={action} value={action}>
                  {actionLabel(action)}
                </option>
              ))}
            </select>
          </label>

          <label className="ss-label" htmlFor="audit-actor">
            <span>Who</span>
            <select id="audit-actor" className="ss-input" value={filters.actorId} onChange={(e) => set({ actorId: e.target.value })}>
              <option value="">Anyone</option>
              {(listing?.actors ?? []).map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.label}
                </option>
              ))}
            </select>
          </label>

          <label className="ss-label" htmlFor="audit-entity">
            <span>Visit or upload id</span>
            <input
              id="audit-entity"
              className="ss-input"
              placeholder="Paste an id"
              value={filters.entityId}
              onChange={(e) => set({ entityId: e.target.value.trim() })}
            />
          </label>

          <label className="ss-label" htmlFor="audit-from">
            <span>From</span>
            <input id="audit-from" className="ss-input" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          </label>

          <label className="ss-label" htmlFor="audit-to">
            <span>To</span>
            <input id="audit-to" className="ss-input" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
          </label>

          <label className="ss-label" htmlFor="audit-limit">
            <span>Show</span>
            <select id="audit-limit" className="ss-input" value={filters.limit} onChange={(e) => set({ limit: e.target.value })}>
              {AUDIT_LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  Newest {limit}
                </option>
              ))}
            </select>
          </label>

          <div className="audit-filter-actions">
            {/* A GET, so it needs no CSRF token and can be a plain link: the browser saves it as a file. */}
            <a className="ss-button ss-button-accent" href={`/api/audit?${query}&format=csv`} download>
              Export CSV
            </a>
            <button type="button" className="ss-text-button" onClick={() => setFilters(BLANK)} disabled={!filtered}>
              Clear filters
            </button>
          </div>
        </form>

        <section className="provider-patients">
          <div className="provider-section-head">
            <div>
              <p className="ss-eyebrow">ENTRIES</p>
              <h2>{filtered ? "Matching this filter." : "Newest first."}</h2>
            </div>
            <span aria-live="polite">
              {loading ? "Reading…" : `${entries.length} of ${listing?.total ?? 0} shown`}
            </span>
          </div>

          {error && (
            <div className="ss-error" role="alert">
              {error}
            </div>
          )}

          <div className="provider-table-card ss-card">
            <div className="provider-table-scroll">
              <table className="provider-table audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>On</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td data-label="When">
                        <span className="audit-when">{when(entry.at)}</span>
                      </td>
                      <td data-label="Who">
                        <strong>{entry.actor}</strong>
                        {entry.actorType !== "user" && <small className="audit-actor-type">{entry.actorType}</small>}
                      </td>
                      <td data-label="What">{actionLabel(entry.action)}</td>
                      <td data-label="On">
                        {entry.entityId ? (
                          <span className="audit-entity">
                            <span className="audit-entity-type">{entry.entityType}</span>
                            {entry.entityType === "visit" ? (
                              // Opening the visit is itself a read, and will be the next row in this table.
                              <Link href={`/provider/${meId}?visit=${entry.entityId}`} title={entry.entityId}>
                                {shortId(entry.entityId)}
                              </Link>
                            ) : (
                              <code title={entry.entityId}>{shortId(entry.entityId)}</code>
                            )}
                          </span>
                        ) : (
                          <span className="audit-entity-type">{entry.entityType}</span>
                        )}
                      </td>
                      <td data-label="Detail">
                        {entry.detail ? (
                          <span className="audit-detail">
                            {Object.entries(entry.detail).map(([key, value]) => (
                              <span key={key} className={key === "droppedFields" ? "ss-pill ss-pill-warning" : "ss-pill ss-pill-info"}>
                                {key} {Array.isArray(value) ? value.join(" ") : String(value)}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="audit-entity-type">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!loading && entries.length === 0 && (
              <p className="audit-empty">
                {filtered
                  ? "Nothing matches that filter. Widen the dates, or clear the filters to see the whole trail."
                  : "Nothing has been recorded yet. Rows appear as soon as a patient opens their link or a summary is read."}
              </p>
            )}
          </div>
        </section>

        <footer className="provider-footer">
          <span>Sweet Spot · Audit trail</span>
          <span>Kept for the practice&apos;s retention window · §10.2</span>
        </footer>
      </div>
    </main>
  );
}
