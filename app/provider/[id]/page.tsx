// The Sour view is behind sign-in (design §5.1). The id in the path is the provider's own, which is what the
// summary email deep-links to; a signed-in provider asking for someone else's is sent to their own dashboard
// rather than shown another practice's workspace. Per-route membership and role checks are T06 (§5.2).

import { redirect } from "next/navigation";
import { currentProvider } from "@/lib/auth";
import SourView from "./sour";

export default async function ProviderSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  if (provider.id !== id) redirect("/provider");
  return <SourView id={id} />;
}
