// /provider/settings is the admin's half of the workspace (design §2.1, §5.2): the practice name, the
// retention window that §10.4's sweep reads, and who works here.
//
// Guarded on the server, like the rest of /provider: no session means the sign-in page, and a clinician or a
// staff account is sent back to the dashboard rather than shown a screen whose every button they would be
// refused. The same capability is checked again by each route the form posts to — this is the door, not the
// lock (lib/guard.ts).

import { redirect } from "next/navigation";
import { can } from "@/lib/access";
import { currentProvider } from "@/lib/auth";
import { canSendOrMailbox } from "@/lib/mailer";
import PracticeSettings from "./settings";

export default async function SettingsPage() {
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  if (!can(provider.role, "practice:manage")) redirect("/provider");
  // T131 (§2.1, §5.1, §8.1): whether this deployment can put an email in front of a colleague at all — the
  // invite nudge and, more to the point, the magic link that is the only way they ever sign in. Settled from
  // the environment here rather than fetched, because the invite card's hint is read before the admin has
  // done anything, and asked here rather than in the client component because the answer is the server's
  // (lib/mailer.ts) and a client bundle has no business with it (§10.6).
  return <PracticeSettings meId={provider.id} canEmail={canSendOrMailbox()} />;
}
