// Everything under /s/<token> — the Sweetie chat and the intake page — is behind the code screen (§2.3, §5.3).
import type { ReactNode } from "react";
import VerifyGate from "@/components/VerifyGate";

export default async function SweetieLayout({ children, params }: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VerifyGate token={token}>{children}</VerifyGate>;
}
