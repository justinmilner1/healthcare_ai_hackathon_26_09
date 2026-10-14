// /provider is behind sign-in (design §5.1). The session is read on the server, so an unauthenticated visitor
// is sent to the sign-in page before any practice data is fetched, and the dashboard below never has to guess
// which workspace it is showing.

import { redirect } from "next/navigation";
import { currentProvider } from "@/lib/auth";
import ProviderDashboard from "./dashboard";

export default async function ProviderPage() {
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  return <ProviderDashboard providerId={provider.id} />;
}
