"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/csrf";

export default function DexcomDemoLink({ token, disabled = false, compact = false, buttonClassName }: { token: string; disabled?: boolean; compact?: boolean; buttonClassName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch("/api/dexcom/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not start the demo.");
      if (typeof data?.token !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.token)) throw new Error("Invalid demo response.");
      window.location.assign(`/s/${data.token}/intake?demo=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the demo.");
      setBusy(false);
    }
  }
  return (
    <div className={compact ? "text-sm" : "mt-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"}>
      {!compact && <p>Explore with synthetic glucose readings in a separate demo session. Your patient record and uploads will not change.</p>}
      <button type="button" disabled={disabled || busy} onClick={start} className={buttonClassName ?? "min-h-11 rounded-lg border border-amber-700 px-3 py-2 font-semibold disabled:opacity-50"}>
        {busy ? "Opening demo…" : compact ? "Connect Dexcom · Demo" : "Try Dexcom sandbox"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
