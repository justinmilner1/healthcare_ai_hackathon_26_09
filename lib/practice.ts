// Practices and the people in them (design §4.1, §4.2). A provider is a User in a Practice. Sign-in is
// Auth.js magic links (§5.1, lib/auth.ts); roles are enforced per route in T06, which also replaces the
// open sign-up below with invites.

import { db } from "./db";

export const DEMO_PROVIDER_EMAIL = "demo@sweetspot.local";

const DEMO = { name: "Dr. Demo Endo", email: DEMO_PROVIDER_EMAIL, practice: "Sweet Spot Endocrinology" };

/** The practice name for an address that signs in without having filled in the sign-up form (lib/authAdapter.ts).
 *  The email domain reads better on the dashboard than the address does, and an admin renames it in T06. */
export function practiceNameFor(email: string): string {
  const label = email.split("@")[1]?.split(".")[0]?.replace(/[^A-Za-z0-9]+/g, " ").trim() ?? "";
  if (!label) return "New practice";
  return label.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** A provider and the practice they belong to. Idempotent on email, like the old Provider upsert. */
export async function upsertProvider(p: { name: string; email: string; practice?: string | null }) {
  const email = p.email.trim().toLowerCase();
  const practiceName = p.practice?.trim() || p.name;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    if (p.practice?.trim()) await db.practice.update({ where: { id: existing.practiceId }, data: { name: practiceName } });
    return db.user.update({ where: { id: existing.id }, data: { name: p.name }, include: { practice: true } });
  }
  // The first person in a practice runs it (§5.2); invites come in T06.
  return db.user.create({
    data: { name: p.name, email, role: "admin", practice: { create: { name: practiceName } } },
    include: { practice: true },
  });
}

/** The provider `npm run seed`, `/demo` and an unattributed booking all land on. */
export const ensureDemoProvider = () => upsertProvider(DEMO);
