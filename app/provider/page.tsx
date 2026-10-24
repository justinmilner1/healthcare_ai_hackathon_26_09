// /provider is behind sign-in (design §5.1). The session is read on the server, so an unauthenticated visitor
// is sent to the sign-in page before any practice data is fetched, and the dashboard below never has to guess
// which workspace it is showing.

import { redirect } from "next/navigation";
import { currentProvider } from "@/lib/auth";
import { inviteFaultByChannel } from "@/lib/notify";
import { practiceIsDemo } from "@/lib/practice";
import ProviderDashboard from "./dashboard";

export default async function ProviderPage() {
  const provider = await currentProvider();
  if (!provider) redirect("/provider/signin");
  // T140 (§2.2, §8.1): which of §2.2's contact channels this deployment has a sender behind, and staff's
  // words for the ones it has not. Settled from the environment here rather than fetched, because step 3 of
  // the booking wizard is the screen the channel is chosen on and the answer has to be on it before anything
  // is typed — and asked here rather than in the client component because lib/notify.ts reaches lib/email.ts
  // and lib/sms.ts, which have no business in a client bundle (§10.6). The same shape as the practice
  // settings page's `canEmail` (app/provider/settings/page.tsx, T131).
  // T145 (§13.4): and whether this practice is marked synthetic, which closes every channel whose
  // destination is not itself reserved — a fact about the practice rather than about the deployment, and the
  // one the booking wizard had no way of knowing. One column (`practiceIsDemo`, lib/practice.ts), read here
  // for the same reasons as the faults above: step 3 needs it before anything is typed, and the client has
  // no business holding a Prisma client (§10.6).
  return <ProviderDashboard providerId={provider.id} channelFaults={inviteFaultByChannel()} isDemo={await practiceIsDemo(provider.practiceId)} />;
}
