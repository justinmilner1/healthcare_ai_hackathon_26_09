"use server";

// The two state-changing things a provider does with their own session (design §5.1). Both are server
// actions, so the browser posts to the page it is on and Auth.js sets the cookie server-side; there is no
// client-side auth code and no token in any URL the patient flow does not already use.

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";

/** Ask for a magic link, then land on our own "check your email" page. */
export async function requestSignInLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect("/provider/signin?error=InvalidEmail");

  let outcome: string;
  try {
    // redirect: false, because letting Auth.js do the redirecting from inside a server action leaves its own
    // /api/auth/verify-request in the address bar — that route only redirects on to the page below, but the
    // client applies the hop without rewriting the URL. So we read where it wanted to go and go ourselves.
    outcome = await signIn("email", { email, redirect: false, redirectTo: "/provider" });
  } catch (e) {
    // A redirect is how a server action finishes; only a real Auth.js failure is ours to report.
    if (e instanceof AuthError) redirect(`/provider/signin?error=${encodeURIComponent(e.type)}`);
    throw e;
  }

  // Auth.js reports a failure by sending the browser back to the sign-in page with ?error=; anything else
  // means the link is on its way. The base is only there to let a relative URL be parsed.
  const error = new URL(outcome, "https://sweet.spot.invalid").searchParams.get("error");
  redirect(error ? `/provider/signin?error=${encodeURIComponent(error)}` : "/provider/check-email");
}

/** Delete the session row and the cookie, then go back to the landing page. */
export async function signOutProvider(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
