// Reading and changing a practice's team (design §2.1, §4.1, §4.2, §5.2). Owner: identity.
//
// The database half of lib/team.ts, which holds the shapes and every validator these three writers use — the
// same split as lib/sour.ts and lib/sourRun.ts. Each writer throws HttpError (lib/httpError.ts) so the routes
// in app/api/practice stay thin, as AGENTS.md asks, and so a refusal is logged with its reason by withRoute.
//
// An invite is the User row; see lib/team.ts for why there is no Invite table.

import { isRole, type Role } from "./access";
import { db } from "./db";
import { HttpError } from "./httpError";
import { log, markDemoPractice } from "./log";
import { sendTeamInvite } from "./mailer";
import {
  cleanPersonName,
  cleanPracticeName,
  cleanRetentionDays,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  normalizeEmail,
  parseRole,
  type PracticeTeam,
  type TeamMember,
} from "./team";

type UserRow = { id: string; email: string; name: string | null; role: string; createdAt: Date; emailVerified: Date | null };

/** One row of the users table, as the settings screen reads it. `pending` is "has never redeemed a link". */
const member = (u: UserRow): TeamMember => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
  pending: u.emailVerified === null,
});

/** Everything the settings page shows: the practice, and who works in it, admins first then by name. */
export async function practiceTeam(practiceId: string): Promise<PracticeTeam> {
  const practice = await db.practice.findUnique({
    where: { id: practiceId },
    include: { users: { orderBy: [{ role: "asc" }, { createdAt: "asc" }] } },
  });
  // The session named this practice, so it existed a moment ago; gone means the row was deleted under us.
  if (!practice) throw new HttpError(404, "practice not found", "practice_not_found", { practiceId });
  return {
    practice: { id: practice.id, name: practice.name, retentionDays: practice.retentionDays, isDemo: practice.isDemo },
    users: practice.users.map(member),
  };
}

/** Rename the practice, change its retention window, or both. An absent field is left alone; a present field
 *  that does not survive its validator is a 400, so "retention: banana" never becomes a silent no-op. */
export async function updatePracticeSettings(practiceId: string, patch: { name?: unknown; retentionDays?: unknown }): Promise<PracticeTeam> {
  const data: { name?: string; retentionDays?: number } = {};

  if (patch.name !== undefined) {
    const name = cleanPracticeName(patch.name);
    if (!name) throw new HttpError(400, "The practice needs a name.", "practice_name_invalid", { practiceId });
    data.name = name;
  }
  if (patch.retentionDays !== undefined) {
    const retentionDays = cleanRetentionDays(patch.retentionDays);
    if (retentionDays === null) {
      throw new HttpError(400, `Keep data for a whole number of days between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}.`, "retention_days_invalid", { practiceId });
    }
    data.retentionDays = retentionDays;
  }
  if (!Object.keys(data).length) throw new HttpError(400, "Nothing to change.", "practice_patch_empty", { practiceId });

  await db.practice.update({ where: { id: practiceId }, data });
  log.info("practice_settings_changed", { practiceId, days: data.retentionDays, count: Object.keys(data).length });
  return practiceTeam(practiceId);
}

/**
 * Invite someone into this practice with a role (§2.1). Idempotent on nothing: a second invite for an address
 * that is already here is a 409, because quietly re-sending would also quietly overwrite their role, and
 * changing a role is `setMemberRole` — a separate, visible act.
 */
export async function inviteMember(opts: {
  practiceId: string;
  email: unknown;
  name?: unknown;
  role?: unknown;
  /** The admin doing the inviting. Named in the email so the recipient knows why it arrived. */
  invitedBy: { id: string; name: string | null; email: string };
}): Promise<{ member: TeamMember; sent: boolean; error?: string }> {
  const email = normalizeEmail(opts.email);
  if (!email) throw new HttpError(400, "That does not look like an email address.", "invite_email_invalid", { practiceId: opts.practiceId });

  const role = parseRole(opts.role);
  if (!role) throw new HttpError(400, "Pick a role: admin, clinician or staff.", "invite_role_invalid", { practiceId: opts.practiceId });

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    // Which of the two it is matters to the admin reading it and gives nothing away: they typed the address.
    const message =
      existing.practiceId === opts.practiceId
        ? "That address is already in this practice."
        : "That address already belongs to another practice. They have to leave it before they can join yours.";
    throw new HttpError(409, message, "invite_email_taken", { practiceId: opts.practiceId, userId: opts.invitedBy.id });
  }

  const practice = await db.practice.findUnique({ where: { id: opts.practiceId } });
  if (!practice) throw new HttpError(404, "practice not found", "practice_not_found", { practiceId: opts.practiceId });
  markDemoPractice(practice); // §13.4's label for everything this request logs from here on

  const created = await db.user.create({
    data: { practiceId: opts.practiceId, email, name: cleanPersonName(opts.name), role },
  });
  log.info("user_invited", { practiceId: opts.practiceId, userId: created.id, role, providerId: opts.invitedBy.id });

  // The row is the invite, so a send that fails costs nothing: the person can still be told to sign in, and
  // the admin sees `sent: false` rather than a half-made user.
  const result = await sendTeamInvite(email, {
    practiceName: practice.name,
    invitedBy: opts.invitedBy.name ?? opts.invitedBy.email,
    role,
    // §13.4 A demo practice's invite goes to a reserved address or nowhere; the User row is made either way.
    demo: practice.isDemo,
  });

  return { member: member(created), sent: result.sent, error: result.error };
}

/** Change a colleague's role. A practice always keeps one admin, or nobody can invite, rename or set retention
 *  again — so the last one cannot be demoted, including by themselves. */
export async function setMemberRole(opts: { practiceId: string; userId: string; role: unknown; actorId: string }): Promise<TeamMember> {
  // No default here, unlike an invite: a role change says which role, or it is not a role change.
  if (!isRole(opts.role)) throw new HttpError(400, "Pick a role: admin, clinician or staff.", "role_invalid", { practiceId: opts.practiceId });
  const role: Role = opts.role;

  const existing = await db.user.findUnique({ where: { id: opts.userId } });
  // Another practice's user is a 404 here for the same reason a visit is (lib/guard.ts).
  if (!existing || existing.practiceId !== opts.practiceId) {
    throw new HttpError(404, "user not found", "user_not_in_practice", { practiceId: opts.practiceId, userId: opts.actorId });
  }
  if (existing.role === role) return member(existing);

  if (existing.role === "admin") {
    const admins = await db.user.count({ where: { practiceId: opts.practiceId, role: "admin" } });
    if (admins <= 1) {
      throw new HttpError(409, "This is the practice's only admin. Make someone else an admin first.", "last_admin", {
        practiceId: opts.practiceId,
        userId: opts.actorId,
      });
    }
  }

  const updated = await db.user.update({ where: { id: existing.id }, data: { role } });
  log.info("user_role_changed", { practiceId: opts.practiceId, userId: updated.id, role, providerId: opts.actorId });
  return member(updated);
}
