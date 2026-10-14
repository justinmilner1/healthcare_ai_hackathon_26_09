// /provider/audit is the §10.2 audit page: "readable by practice admins", so it is admin only, like
// /provider/settings beside it. Guarded on the server — no session means the sign-in page, and a clinician or
// a staff account is sent back to the dashboard rather than shown a screen whose data they would be refused.
// GET /api/audit checks the same capability again; this is the door, not the lock (lib/guard.ts).

import { redirect } from "next/navigation";
import { can } from "@/lib/access";
import { currentProvider } from "@/lib/auth";
import AuditTrail from "./audit";

export default async function AuditPage() {
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  if (!can(provider.role, "audit:read")) redirect("/provider");
  return <AuditTrail meId={provider.id} />;
}
