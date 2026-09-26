"use client";

import { useEffect, useState } from "react";

const returnKey = (token: string) => `dexcom-demo-return:${token}`;

// Return links stay in this browser tab, never in OAuth URLs or the demo record.
export function DemoReturnLink({ token }: { token: string }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    try {
      const source = sessionStorage.getItem(returnKey(token));
      if (source && /^[A-Za-z0-9_-]+$/.test(source)) setHref(`/s/${source}/intake`);
    } catch { /* Browser storage is optional. */ }
  }, [token]);
  return href ? <a href={href} className="mt-2 inline-block font-semibold underline">Return to my intake</a> : null;
}

export default function DexcomDemoLink({ token, disabled = false }: { token: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/dexcom/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not start the demo.");
      if (typeof data?.token !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.token)) throw new Error("Invalid demo response.");
      try { sessionStorage.setItem(returnKey(data.token), token); } catch { /* Existing intake remains accessible at its original link. */ }
      window.location.assign(`/s/${data.token}/intake?demo=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the demo.");
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p>Explore with synthetic glucose readings in a separate demo session. Your patient record and uploads will not change.</p>
      <button type="button" disabled={disabled || busy} onClick={start} className="rounded-lg border border-amber-700 px-3 py-2 font-semibold disabled:opacity-50">
        {busy ? "Opening demo…" : "Try Dexcom sandbox"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
