"use server";

// The two state-changing things a provider does with their own session (design §5.1). Both are server
// actions, so the browser posts to the page it is on and Auth.js sets the cookie server-side; there is no
// client-side auth code and no token in any URL the patient flow does not already use.

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";

/** Ask for a magic link. Auth.js answers with a redirect to /provider/check-email (authConfig.pages). */
export async function requestSignInLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect("/provider/signin?error=InvalidEmail");
  try {
    await signIn("email", { email, redirectTo: "/provider" });
  } catch (e) {
    // A redirect is how a server action finishes; only a real Auth.js failure is ours to report.
    if (e instanceof AuthError) redirect(`/provider/signin?error=${encodeURIComponent(e.type)}`);
    throw e;
  }
}

/** Delete the session row and the cookie, then go back to the landing page. */
export async function signOutProvider(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
