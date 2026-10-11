// Practices and the people in them (design §4.1, §4.2). Provider sign-in is T05 and roles are T06; until
// then a provider is a User in a Practice, created on demand, which is the hackathon behaviour one table
// further along: "a hardcoded provider beats a broken login" (AGENTS.md).

import { db } from "./db";

export const DEMO_PROVIDER_EMAIL = "demo@sweetspot.local";

const DEMO = { name: "Dr. Demo Endo", email: DEMO_PROVIDER_EMAIL, practice: "Sweet Spot Endocrinology" };

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
