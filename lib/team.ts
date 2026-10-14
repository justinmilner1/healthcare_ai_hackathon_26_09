// The people in a practice, and the two settings that govern it (design §2.1, §4.1, §4.2, §5.2). Owner: identity.
//
// There is no Invite table, because §4 has none and does not need one: **an invite is the User row**. An admin
// creates it with the practice and the role already on it; the first magic link that address asks for signs
// them straight in, because Auth.js finds the row instead of calling `createUser`, so they land in the practice
// they were invited to rather than starting one of their own (lib/authAdapter.ts). Nothing in the invite email
// is a credential — it points at /provider/signin, and the link that actually signs them in arrives in their
// own inbox (§5.1) — so a forwarded invite is worth nothing.
//
// The validators are first and pure: every string that reaches the database goes through one of them, and
// lib/team.test.ts checks them without a database. The three writers below throw HttpError (lib/httpError.ts)
// so the routes stay thin, as AGENTS.md asks.

import { DEFAULT_ROLE, isRole, type Role } from "./access";
import { db } from "./db";
import { HttpError } from "./httpError";
import { log } from "./log";
import { sendTeamInvite } from "./mailer";

/** §10.4's retention window, bounded so a typo cannot mean "keep nothing" or "keep for ever". */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_PRACTICE_NAME = 120;
export const MAX_PERSON_NAME = 120;

// The same shape the sign-in action insists on (app/provider/actions.ts): an address with a dot in the domain.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A storable address, or null. Lower-cased and trimmed, which is what `User.email` is unique on. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 320 ? email : null;
}

/** A person's name as typed, capped. Blank is null rather than "": Auth.js fills it in on first sign-in. */
export function cleanPersonName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_PERSON_NAME);
  return name || null;
}

/** A practice name, or null when there is nothing left after trimming. A practice always has a name (§4.1). */
export function cleanPracticeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_PRACTICE_NAME);
  return name || null;
}

/** A whole number of days inside the bounds, from a number or the string a form sends. Null if it is neither. */
export function cleanRetentionDays(raw: unknown): number | null {
  const days = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(days)) return null;
  return days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : null;
}

/** The role an admin picked, or the default when the form sent nothing. Undefined for a value that is not a
 *  role at all, which the caller reports rather than quietly downgrading. */
export function parseRole(raw: unknown): Role | undefined {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_ROLE;
  return isRole(raw) ? raw : undefined;
}

export type TeamMember = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
  /** True until their first magic link has been redeemed — an invite that has not been taken up yet (§5.1). */
  pending: boolean;
};

export type PracticeTeam = {
  practice: { id: string; name: string; retentionDays: number };
  users: TeamMember[];
};

/** Everything the settings page shows: the practice, and who works in it, admins first then by name. */
export async function practiceTeam(practiceId: string): Promise<PracticeTeam> {
  const practice = await db.practice.findUnique({
    where: { id: practiceId },
    include: { users: { orderBy: [{ role: "asc" }, { createdAt: "asc" }] } },
  });
  // The session named this practice, so it existed a moment ago; gone means the row was deleted under us.
  if (!practice) throw new HttpError(404, "practice not found", "practice_not_found", { practiceId });
  return {
    practice: { id: practice.id, name: practice.name, retentionDays: practice.retentionDays },
    users: practice.users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      pending: u.emailVerified === null,
    })),
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
  });

  return {
    member: { id: created.id, email: created.email, name: created.name, role: created.role, createdAt: created.createdAt, pending: true },
    sent: result.sent,
    error: result.error,
  };
}

/** Change a colleague's role. A practice always keeps one admin, or nobody can invite, rename or set retention
 *  again — so the last one cannot be demoted, including by themselves. */
export async function setMemberRole(opts: { practiceId: string; userId: string; role: unknown; actorId: string }): Promise<TeamMember> {
  // No default here, unlike an invite: a role change says which role, or it is not a role change.
  if (!isRole(opts.role)) throw new HttpError(400, "Pick a role: admin, clinician or staff.", "role_invalid", { practiceId: opts.practiceId });
  const role: Role = opts.role;

  const member = await db.user.findUnique({ where: { id: opts.userId } });
  // Another practice's user is a 404 here for the same reason a visit is (lib/guard.ts).
  if (!member || member.practiceId !== opts.practiceId) {
    throw new HttpError(404, "user not found", "user_not_in_practice", { practiceId: opts.practiceId, userId: opts.actorId });
  }
  if (member.role === role) {
    return { id: member.id, email: member.email, name: member.name, role: member.role, createdAt: member.createdAt, pending: member.emailVerified === null };
  }

  if (member.role === "admin") {
    const admins = await db.user.count({ where: { practiceId: opts.practiceId, role: "admin" } });
    if (admins <= 1) {
      throw new HttpError(409, "This is the practice's only admin. Make someone else an admin first.", "last_admin", {
        practiceId: opts.practiceId,
        userId: opts.actorId,
      });
    }
  }

  const updated = await db.user.update({ where: { id: member.id }, data: { role } });
  log.info("user_role_changed", { practiceId: opts.practiceId, userId: updated.id, role, providerId: opts.actorId });
  return { id: updated.id, email: updated.email, name: updated.name, role: updated.role, createdAt: updated.createdAt, pending: updated.emailVerified === null };
}
