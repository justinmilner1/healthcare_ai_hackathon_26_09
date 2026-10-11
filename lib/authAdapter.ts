// The Prisma adapter with the two things design §5.1 and §5.2 need on top of it. Owner: identity.
//
//   1. An absolute session cap. Auth.js keeps database sessions alive with one clock, `Session.expires`, and
//      rolls it forward by the idle window on every request — so a tab left open renews for ever. §5.1 wants
//      both clocks: 12 hours idle AND 7 days absolute. `Session.createdAt` never moves, so the wrapper below
//      drops the row the first time it is read past the cap, and Auth.js then clears the cookie.
//   2. A practice for a brand-new user. Auth.js creates the User row when an unknown address clicks its link,
//      and `User.practiceId` is required (§4.2). The first person in a practice runs it, which is what
//      lib/practice.ts already does for the signup form. Invite-only sign-up is T06.

import type { Adapter, AdapterSession, AdapterUser } from "@auth/core/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";
import { log } from "./log";
import { practiceNameFor } from "./practice";

/** §5.1: however much the idle clock is renewed, a session dies 7 days after it was created. */
export const ABSOLUTE_SESSION_SECONDS = 7 * 24 * 60 * 60;

export function isPastAbsoluteCap(createdAt: Date, now: Date = new Date(), capSeconds = ABSOLUTE_SESSION_SECONDS): boolean {
  return now.getTime() - createdAt.getTime() >= capSeconds * 1000;
}

export function authAdapter(prisma: PrismaClient, now: () => Date = () => new Date()): Adapter {
  const base = PrismaAdapter(prisma);
  return {
    ...base,

    async createUser(user) {
      const email = user.email.trim().toLowerCase();
      const created = await prisma.user.create({
        data: {
          email,
          emailVerified: user.emailVerified ?? null,
          name: user.name ?? null,
          image: user.image ?? null,
          role: "admin",
          practice: { create: { name: practiceNameFor(email) } },
        },
      });
      log.info("provider_created", { userId: created.id, practiceId: created.practiceId, role: created.role });
      return created as AdapterUser;
    },

    async getSessionAndUser(sessionToken) {
      const found = await base.getSessionAndUser!(sessionToken);
      if (!found) return null;
      // getSessionAndUser spreads the whole row, so createdAt is here even though AdapterSession omits it.
      const { createdAt } = found.session as AdapterSession & { createdAt?: Date };
      if (createdAt && isPastAbsoluteCap(createdAt, now())) {
        await base.deleteSession!(sessionToken);
        log.info("session_absolute_expiry", { userId: found.user.id });
        return null;
      }
      return found;
    },
  };
}
