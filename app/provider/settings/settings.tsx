"use client";

// The practice settings screen (design §2.1, §4.1, §5.2). Rendered by page.tsx, which is the server component
// that checks the session and the admin role. Data comes from GET /api/practice and goes back through
// PATCH /api/practice, POST /api/practice/users and PATCH /api/practice/users/[id] — every one of them
// admin-only and scoped to this practice, so there is no practice id anywhere in this file to get wrong.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import { ROLES, roleDescription, roleLabel, type Role } from "@/lib/access";
import { apiFetch } from "@/lib/csrf";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, type PracticeTeam } from "@/lib/team";

type Note = { kind: "success" | "error"; text: string } | null;

export default function PracticeSettings({ meId }: { meId: string }) {
  const [team, setTeam] = useState<PracticeTeam | null>(null);
  const [name, setName] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [invite, setInvite] = useState({ email: "", name: "", role: "staff" as Role });
  const [practiceNote, setPracticeNote] = useState<Note>(null);
  const [inviteNote, setInviteNote] = useState<Note>(null);
  const [teamNote, setTeamNote] = useState<Note>(null);
  const [busy, setBusy] = useState("");

  /** Adopt a fresh team payload, and re-fill the practice form from it so the inputs match what was saved. */
  const adopt = useCallback((next: PracticeTeam) => {
    setTeam(next);
    setName(next.practice.name);
    setRetentionDays(String(next.practice.retentionDays));
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/practice");
    if (response.status === 401) {
      window.location.href = "/provider/signin";
      return;
    }
    // A 403 means the role changed under us — another admin demoted this account while the page was open.
    if (response.status === 403) {
      window.location.href = "/provider";
      return;
    }
    if (response.ok) adopt(await response.json());
  }, [adopt]);

  useEffect(() => {
    load();
  }, [load]);

  /** One place for "post it, read the error the route wrote, keep the reply". Every form below uses it.
   *  apiFetch, not fetch: middleware refuses a state-changing request that does not echo the CSRF cookie
   *  back in a header (§10.8, lib/csrf.ts), which is a 403 before the route is reached. */
  async function send(url: string, method: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "That did not work. Try again.");
    return data;
  }

  async function savePractice(e: React.FormEvent) {
    e.preventDefault();
    setPracticeNote(null);
    setBusy("practice");
    try {
      const data = await send("/api/practice", "PATCH", { name, retentionDays });
      adopt(data as unknown as PracticeTeam);
      setPracticeNote({ kind: "success", text: "Saved." });
    } catch (error) {
      setPracticeNote({ kind: "error", text: error instanceof Error ? error.message : "Could not save." });
    } finally {
      setBusy("");
    }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteNote(null);
    setBusy("invite");
    try {
      const data = await send("/api/practice/users", "POST", invite);
      adopt(data.team as PracticeTeam);
      const email = invite.email.trim();
      setInvite({ email: "", name: "", role: "staff" });
      // The row is the invite, so a send that failed is worth saying out loud rather than hiding: the person
      // is in the practice either way and can be told to sign in by hand.
      setInviteNote(
        data.sent
          ? { kind: "success", text: `Invited ${email}. They can sign in with that address now.` }
          : { kind: "error", text: `${email} was added, but the email did not go out${data.error ? `: ${data.error}` : ""}. Ask them to sign in with that address.` },
      );
    } catch (error) {
      setInviteNote({ kind: "error", text: error instanceof Error ? error.message : "Could not invite." });
    } finally {
      setBusy("");
    }
  }

  async function changeRole(userId: string, role: string) {
    setTeamNote(null);
    setBusy(userId);
    try {
      const data = await send(`/api/practice/users/${userId}`, "PATCH", { role });
      adopt(data.team as PracticeTeam);
      setTeamNote({ kind: "success", text: `Role changed to ${roleLabel(role).toLowerCase()}.` });
    } catch (error) {
      setTeamNote({ kind: "error", text: error instanceof Error ? error.message : "Could not change the role." });
      // The select shows the role that did not take, so put the saved state back on screen.
      await load();
    } finally {
      setBusy("");
    }
  }

  if (!team) {
    return (
      <main className="ss-page sour-theme">
        <div className="provider-loading">
          <span className="provider-loading-dots">Opening practice settings</span>
        </div>
      </main>
    );
  }

  return (
    <main className="ss-page sour-theme provider-dashboard">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Practice settings" />
          <div className="provider-top-actions">
            <Link href="/provider" className="ss-button">
              ← Dashboard
            </Link>
            {/* Settings and the audit trail are the admin's two screens; each links to the other (§10.2).
                Second, because a phone hides the first button in this row (globals.css, under 680px). */}
            <Link href="/provider/audit" className="ss-button">
              Audit
            </Link>
            <Link href="/provider/signout" className="ss-text-button">
              Sign out
            </Link>
          </div>
        </header>

        <section className="provider-section-head settings-head">
          <div>
            <p className="ss-eyebrow">PRACTICE SETTINGS</p>
            <h1 className="ss-title">{team.practice.name}</h1>
            {/* §13.4's flag, said once where an admin cannot miss it: three of the rules on this screen read
                differently for a demo practice, and the card below says which. Read-only — a practice is
                marked synthetic when it is seeded, not from a form. */}
            {team.practice.isDemo && <p className="ss-pill ss-pill-warning settings-demo-pill">DEMO PRACTICE — SYNTHETIC DATA</p>}
            <p className="ss-lede">
              What this practice is called, how long its data is kept, and who works in it. Admins only.
            </p>
          </div>
        </section>

        <section className="settings-grid">
          <form className="ss-card settings-card" onSubmit={savePractice}>
            <h2>The practice</h2>
            <p className="settings-hint">
              The name patients see in their invite and pre-visit check-in. Retention is how long a visit&apos;s
              messages, uploads and summaries are kept before the nightly sweep removes them.
            </p>
            {practiceNote && (
              <div className={practiceNote.kind === "error" ? "ss-error" : "ss-success"} role={practiceNote.kind === "error" ? "alert" : "status"}>
                {practiceNote.text}
              </div>
            )}
            <label className="ss-label" htmlFor="practice-name">
              <span>Practice name</span>
              <input id="practice-name" className="ss-input" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ss-label" htmlFor="retention-days">
              <span>Keep patient data for</span>
              <input
                id="retention-days"
                className="ss-input"
                type="number"
                inputMode="numeric"
                min={MIN_RETENTION_DAYS}
                max={MAX_RETENTION_DAYS}
                required
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
              />
            </label>
            <p className="settings-hint">
              Days. Between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS}.
            </p>
            {team.practice.isDemo && (
              <p className="settings-hint settings-demo-note">
                This practice is a demo. Its data is synthetic, so the nightly sweep leaves it alone however
                long ago a visit was, its errors are kept out of the on-call alarms, and nothing it sends can
                reach a real phone or inbox — messages to anything but a reserved test address are not sent,
                and say so in the Messages column.
              </p>
            )}
            <div className="settings-actions">
              <button className="ss-button ss-button-primary" disabled={busy === "practice"}>
                {busy === "practice" ? "Saving…" : "Save practice"}
              </button>
            </div>
          </form>

          <form className="ss-card settings-card" onSubmit={sendInvite}>
            <h2>Invite someone</h2>
            <p className="settings-hint">
              They get an email asking them to sign in with this address. Nothing in it signs anyone in — the
              one-time link comes to their own inbox.
            </p>
            {inviteNote && (
              <div className={inviteNote.kind === "error" ? "ss-error" : "ss-success"} role={inviteNote.kind === "error" ? "alert" : "status"}>
                {inviteNote.text}
              </div>
            )}
            <label className="ss-label" htmlFor="invite-email">
              <span>Work email</span>
              <input
                id="invite-email"
                className="ss-input"
                type="email"
                required
                placeholder="nurse@practice.com"
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              />
            </label>
            <label className="ss-label" htmlFor="invite-name">
              <span>Their name (optional)</span>
              <input
                id="invite-name"
                className="ss-input"
                placeholder="Dr Maya Chen"
                value={invite.name}
                onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              />
            </label>
            <fieldset className="settings-roles">
              <legend>Role</legend>
              {ROLES.map((role) => (
                <label key={role} className={`settings-role ${invite.role === role ? "settings-role-selected" : ""}`}>
                  <input type="radio" name="invite-role" value={role} checked={invite.role === role} onChange={() => setInvite({ ...invite, role })} />
                  <span>
                    <strong>{roleLabel(role)}</strong>
                    <small>{roleDescription(role)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="settings-actions">
              <button className="ss-button ss-button-accent" disabled={busy === "invite"}>
                {busy === "invite" ? "Inviting…" : "Send invite →"}
              </button>
            </div>
          </form>
        </section>

        <section className="provider-patients">
          <div className="provider-section-head">
            <div>
              <p className="ss-eyebrow">WHO WORKS HERE</p>
              <h2>Users and roles.</h2>
            </div>
            <span>{team.users.length} total</span>
          </div>

          {teamNote && (
            <div className={teamNote.kind === "error" ? "ss-error" : "ss-success"} role={teamNote.kind === "error" ? "alert" : "status"}>
              {teamNote.text}
            </div>
          )}

          <div className="provider-table-card ss-card">
            <div className="provider-table-scroll">
              <table className="provider-table settings-users">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Status</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {team.users.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Person">
                        <div className="provider-patient">
                          <span className="provider-patient-avatar">{(user.name ?? user.email).charAt(0).toUpperCase()}</span>
                          <span>
                            <strong>
                              {user.name ?? user.email}
                              {user.id === meId ? " (you)" : ""}
                            </strong>
                            {/* The address is the heading when there is no name yet, so printing it twice
                                says nothing; what is worth saying is that the name is still to come. */}
                            <small>{user.name ? user.email : "Adds their name when they first sign in"}</small>
                          </span>
                        </div>
                      </td>
                      <td data-label="Status">
                        {user.pending ? (
                          <span className="ss-pill ss-pill-warning">Invited</span>
                        ) : (
                          <span className="ss-pill ss-pill-success">Signed in</span>
                        )}
                      </td>
                      <td data-label="Role">
                        <label className="settings-role-select">
                          <span className="sr-only">Role for {user.name ?? user.email}</span>
                          <select
                            className="ss-input"
                            value={user.role}
                            disabled={busy === user.id}
                            onChange={(e) => changeRole(user.id, e.target.value)}
                          >
                            {ROLES.map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                            {/* A role this build does not know, so the select does not silently rewrite it. */}
                            {!(ROLES as readonly string[]).includes(user.role) && <option value={user.role}>{user.role}</option>}
                          </select>
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer className="provider-footer">
          <span>Sweet Spot · Practice settings</span>
          <span>Only admins can change these</span>
        </footer>
      </div>
    </main>
  );
}
