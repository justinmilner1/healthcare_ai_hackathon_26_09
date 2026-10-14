// The patient's own summary is opened through the same verified link as the intake (design §2.7, §5.3).
import type { ReactNode } from "react";
import VerifyGate from "@/components/VerifyGate";

export default async function PatientSummaryLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VerifyGate token={id}>{children}</VerifyGate>;
}
