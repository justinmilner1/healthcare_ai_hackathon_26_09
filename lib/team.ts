// What a practice's team looks like, and every rule about the values that describe it (design §2.1, §4.1,
// §4.2, §5.2). Owner: identity.
//
// Pure: validators, bounds and the two payload shapes, no database and no mailer, because both halves of the
// app need them. The settings form imports the bounds so the <input min/max> and the server agree on one
// number; lib/teamStore.ts imports the validators so nothing reaches the database without passing one; and
// lib/team.test.ts checks them without a Postgres. Splitting them out is also what keeps Prisma out of the
// browser bundle — the settings screen is a client component (app/provider/settings/settings.tsx).
//
// There is no Invite table, because §4 has none and does not need one: **an invite is the User row**. An admin
// creates it with the practice and the role already on it; the first magic link that address asks for signs
// them straight in, because Auth.js finds the row instead of calling `createUser`, so they land in the practice
// they were invited to rather than starting one of their own (lib/authAdapter.ts). Nothing in the invite email
// is a credential — it points at /provider/signin, and the link that actually signs them in arrives in their
// own inbox (§5.1) — so a forwarded invite is worth nothing.

import { DEFAULT_ROLE, isRole, type Role } from "./access";

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
  /** ISO, not a Date: this shape crosses JSON to the settings screen, where a Date would already be a string. */
  createdAt: string;
  /** True until their first magic link has been redeemed — an invite that has not been taken up yet (§5.1). */
  pending: boolean;
};

export type PracticeTeam = {
  practice: { id: string; name: string; retentionDays: number };
  users: TeamMember[];
};
