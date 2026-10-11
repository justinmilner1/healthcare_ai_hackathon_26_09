// Provider sign-in (design §5.1). Owner: identity.
//
// Auth.js (next-auth v5) with the Prisma adapter and one provider: an email magic link. There is no password
// anywhere in the product. Sessions are rows in the database, not JWTs, so signing out or a retention sweep
// can end one for real, and the two clocks §5.1 asks for are both enforced:
//
//   idle      12 hours. `Session.expires`, which Auth.js rolls forward on every request (updateAge below
//             decides how often it writes).
//   absolute  7 days from `Session.createdAt`, enforced in lib/authAdapter.ts.
//
// The link itself is sent by lib/mailer.ts: SES in production, a local mailbox in development. Pages come from
// app/provider/signin, check-email and signout; Auth.js redirects to them by the `pages` map below, so its own
// unstyled screens are never shown.

import NextAuth, { type NextAuthConfig, type DefaultSession } from "next-auth";
import type { EmailConfig } from "@auth/core/providers";
import { authAdapter } from "./authAdapter";
import { db } from "./db";
import { log } from "./log";
import { sendSignInLink } from "./mailer";

export const IDLE_SESSION_SECONDS = 12 * 60 * 60;
/** How often the idle clock is written back. Short enough that the 12 hours above mean what they say. */
const SESSION_UPDATE_SECONDS = 15 * 60;
/** How long a sign-in link is good for. One use; Auth.js deletes the token when it is redeemed. */
export const SIGN_IN_LINK_SECONDS = 15 * 60;

/** A provider's own details, carried on the session so a page needs no second query. */
export type ProviderUser = { id: string; email: string; name: string | null; role: string; practiceId: string };

declare module "next-auth" {
  interface Session {
    user: ProviderUser & DefaultSession["user"];
  }
}

// AUTH_SECRET signs the session cookie and hashes the one-time tokens. There is no safe default in a deployed
// environment, so production must supply one; locally a constant keeps `npm run dev` and the e2e suite working
// with no setup. Missing it in production is left to Auth.js, which refuses the request with a Configuration
// error that app/provider/signin names — rather than thrown here, which would also fail `next build`, where
// NODE_ENV is production but nothing is being served. Refusing to start is T31's job (§3.7).
const DEV_SECRET = "sweet-spot-development-secret-not-for-deployment";

function authSecret(): string | undefined {
  const given = process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim();
  if (given) return given;
  if (process.env.NODE_ENV === "production") return undefined;
  log.warn("auth_secret_missing", { ok: false });
  return DEV_SECRET;
}

/** The one provider: an email address, a link, nothing to remember. `sendVerificationRequest` is the transport. */
const emailLink: EmailConfig = {
  id: "email",
  type: "email",
  name: "Email sign-in link",
  maxAge: SIGN_IN_LINK_SECONDS,
  from: process.env.EMAIL_FROM ?? "Sweet Spot <no-reply@sweetspot.local>",
  options: {},
  // No normalizeIdentifier: Auth.js's own already trims and lower-cases, and also rejects the quoted and
  // homoglyph addresses that a downstream parser can split into a second recipient.
  sendVerificationRequest: async ({ identifier, url }) => {
    const result = await sendSignInLink(identifier, url, Math.round(SIGN_IN_LINK_SECONDS / 60));
    if (result.sent) return;
    // A send that failed must not look like a sent link: Auth.js turns a throw into ?error= on the sign-in
    // page. The yield first is for @auth/core's send-token.js, which starts this promise and then awaits a
    // hash before Promise.all attaches a handler to it. Rejecting inside that window — which a send that
    // fails without a network call does — is reported by Node as an unhandled rejection before Auth.js sees
    // the error at all, so the logs get a crash-shaped line for a handled failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw new Error(result.error ?? "could not send the sign-in link");
  },
};

export const authConfig: NextAuthConfig = {
  adapter: authAdapter(db),
  // Self-hosted on Amplify (§3.1), so the host header is the app's own; Auth.js will not trust it otherwise.
  trustHost: true,
  secret: authSecret(),
  session: { strategy: "database", maxAge: IDLE_SESSION_SECONDS, updateAge: SESSION_UPDATE_SECONDS },
  pages: {
    signIn: "/provider/signin",
    verifyRequest: "/provider/check-email",
    signOut: "/provider/signout",
    error: "/provider/signin",
  },
  providers: [emailLink],
  callbacks: {
    // The default callback returns name, email and image only. Pages and routes need the id, the practice and
    // the role (§5.2), and they come straight off the adapter's user row.
    session({ session, user }) {
      const row = user as unknown as ProviderUser;
      session.user = { ...session.user, id: row.id, email: row.email, name: row.name, role: row.role, practiceId: row.practiceId };
      return session;
    },
  },
  events: {
    signIn: ({ user }) => log.info("provider_signed_in", { userId: user.id }),
    // Database strategy, so the event carries the Session row that was just deleted.
    signOut: async (message) => {
      const session = "session" in message ? await message.session : null;
      log.info("provider_signed_out", { userId: session?.userId });
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** The signed-in provider, or null. The one way a page or route asks who is here. */
export async function currentProvider(): Promise<ProviderUser | null> {
  const session = await auth();
  const user = session?.user;
  return user?.id ? { id: user.id, email: user.email, name: user.name ?? null, role: user.role, practiceId: user.practiceId } : null;
}
