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
import PracticeSettings from "./settings";

export default async function SettingsPage() {
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  if (!can(provider.role, "practice:manage")) redirect("/provider");
  return <PracticeSettings meId={provider.id} />;
}
