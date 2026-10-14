// Practices and the first person in one (design §2.1, §4.1, §4.2). A provider is a User in a Practice.
// Sign-in is Auth.js magic links (§5.1, lib/auth.ts); who may do what, once signed in, is lib/access.ts and
// lib/guard.ts (§5.2). Inviting the second person and after is lib/team.ts.

import { db } from "./db";
import { HttpError } from "./httpError";
import { log } from "./log";
import { cleanPersonName, cleanPracticeName, normalizeEmail } from "./team";

export const DEMO_PROVIDER_EMAIL = "demo@sweetspot.local";

const DEMO = { name: "Dr. Demo Endo", email: DEMO_PROVIDER_EMAIL, practice: "Sweet Spot Endocrinology" };

/** The practice name for an address that signs in without having filled in the sign-up form (lib/authAdapter.ts).
 *  The email domain reads better on the dashboard than the address does; an admin renames it in settings. */
export function practiceNameFor(email: string): string {
  const label = email.split("@")[1]?.split(".")[0]?.replace(/[^A-Za-z0-9]+/g, " ").trim() ?? "";
  if (!label) return "New practice";
  return label.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * A provider and the practice they belong to, created or updated. Idempotent on email, which is what `npm run
 * seed` and the demo provider need — re-running the seed must not make a second Sweet Spot Endocrinology.
 *
 * Not for anything a request can reach: it renames the practice of whatever address is handed to it, and
 * nothing here checks that the caller is in that practice. `signUpPractice` below is the public path.
 */
export async function upsertProvider(p: { name: string; email: string; practice?: string | null }) {
  const email = p.email.trim().toLowerCase();
  const practiceName = p.practice?.trim() || p.name;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    if (p.practice?.trim()) await db.practice.update({ where: { id: existing.practiceId }, data: { name: practiceName } });
    return db.user.update({ where: { id: existing.id }, data: { name: p.name }, include: { practice: true } });
  }
  // The first person in a practice runs it (§5.2); everyone after is invited with a role (lib/team.ts).
  return db.user.create({
    data: { name: p.name, email, role: "admin", practice: { create: { name: practiceName } } },
    include: { practice: true },
  });
}

/** The provider `npm run seed`, `/demo` and an unattributed booking all land on. */
export const ensureDemoProvider = () => upsertProvider(DEMO);

/**
 * The public sign-up (§2.1): a brand-new practice with its first user as admin. Create-only, because this is
 * reached with no session at all — `upsertProvider` on an address that already exists would let anyone rename
 * a stranger's practice and overwrite their name by POSTing their email, which is exactly the cross-practice
 * write §5.2 forbids. An address that is already somewhere is sent to sign in instead, where the link in their
 * own inbox is the proof the address is theirs.
 */
export async function signUpPractice(p: { name: unknown; email: unknown; practice?: unknown }) {
  const email = normalizeEmail(p.email);
  if (!email) throw new HttpError(400, "That does not look like an email address.", "signup_email_invalid");
  const name = cleanPersonName(p.name);
  if (!name) throw new HttpError(400, "Your name is required.", "signup_name_invalid");

  if (await db.user.findUnique({ where: { email } })) {
    throw new HttpError(409, "That address already belongs to a practice. Sign in instead, or ask its admin to invite you.", "signup_email_taken");
  }

  const practiceName = cleanPracticeName(p.practice) ?? name;
  const user = await db.user.create({
    data: { name, email, role: "admin", practice: { create: { name: practiceName } } },
    include: { practice: true },
  });
  log.info("practice_created", { practiceId: user.practiceId, userId: user.id, role: user.role });
  return user;
}
