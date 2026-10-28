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

/** A person's name as typed, capped. Blank is null rather than "": nobody has given a name yet, and nothing
 *  will give one on their behalf — a magic link carries an address only, so the name arrives from the invite
 *  form or from the person's own You card, or not at all (T115, memberSubLine below). */
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

/**
 * The two things this practice's screens say instead of a name, as constants because more than one surface
 * says them (T186). One missing name, one wording: a reader who meets an unnamed colleague in the users
 * table and again at the top of their own brief should not have to work out that the two pages are talking
 * about the same gap.
 */
export const NO_NAME_SET = "No name set";
export const NO_NAME_IN_INVITE = "No name in the invite";

/** What a heading reads while the row behind it has not arrived yet, and *only* then. An ellipsis is a
 *  promise that something is still coming, so nothing that has finished may wear one (T186). */
export const NAME_LOADING = "…";

/**
 * The sub line under a person's heading in the users table (§2.1, §4.2). Four cases, and the two without a
 * name are told apart by `pending` — "has this address ever redeemed a link" — rather than by whether a name
 * happens to exist, because those are two different facts (T115).
 *
 * The row used to promise an unnamed person that their name "adds itself when they first sign in", and
 * nothing in the product has ever done that: a magic link carries an address and nothing else, so
 * `authAdapter.createUser` has no name to write (lib/authAdapter.ts, §5.1). Every name that exists was typed
 * by somebody — their own, through the You card on the settings screen, or a colleague's, in the invite — so
 * a row with none says that none is set rather than predicting one, and the admin's own signed-in row no
 * longer contradicts the "Signed in" pill beside it.
 */
export function memberSubLine(member: Pick<TeamMember, "email" | "name" | "pending">): string {
  // The address is already the heading when there is no name, so printing it twice would say nothing; what
  // is worth saying is that there is no name, and why there is not one yet.
  if (member.name) return member.email;
  return member.pending ? NO_NAME_IN_INVITE : NO_NAME_SET;
}

/**
 * The heading over the practice line in the brief's sidebar, which is that page's `<h1>` (§2.6, §12.5).
 *
 * Three states, where the screen used to have two. `null` is "GET /api/provider has not answered yet", and
 * `NAME_LOADING` is what that is for. A row with a name is that name. A row with none is the state the
 * ellipsis used to be shared with, and it is not rare: §2.1 gives every practice an admin with no name
 * until somebody types one into settings, and every colleague an admin invites by email has none either
 * (lib/authAdapter.ts, §5.1), so that heading read `…` for ever and a loaded page was indistinguishable
 * from a loading one.
 *
 * `memberSubLine`'s own answer rather than a fourth wording for one fact — the users table one screen over
 * already tells this practice what an account with no name on it is — and `NO_NAME_SET` rather than
 * `NO_NAME_IN_INVITE` with nothing to ask: whoever is reading a brief redeemed a link to get here, so they
 * are signed in and by definition not pending (§5.1). Not the printed sheet's `NO_CLINICIAN` either, which
 * is a claim about whose visit it is (lib/visit.ts, T86) rather than about the account doing the reading —
 * and lives behind Prisma, where a client component cannot follow it.
 *
 * `||` rather than `??`, as `clinicianLine` does for the same reason: a name that is blank or whitespace is
 * as missing as none at all, and printing it would leave the heading empty.
 */
export function signedInHeading(provider: { name: string | null } | null | undefined): string {
  if (!provider) return NAME_LOADING;
  return provider.name?.trim() || NO_NAME_SET;
}

export type PracticeTeam = {
  /** `isDemo` is §13.4's flag, read-only here: the settings screen says so, and nothing on it sets it. A
   *  practice is marked synthetic when it is seeded (lib/practice.ts), not by a form — an admin who could
   *  turn it on would be turning off their own practice's retention sweep. */
  practice: { id: string; name: string; retentionDays: number; isDemo: boolean };
  users: TeamMember[];
};
