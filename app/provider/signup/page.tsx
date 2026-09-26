"use client";

// Provider sign up. POST /api/provider, remember the provider, go to the dashboard. Owner: Justin.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { rememberProvider } from "@/lib/providerSession";

export default function ProviderSignup() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", practice: "" });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const p = await res.json();
    rememberProvider(p.id);
    router.push("/provider");
  }

  return (
    <main className="mx-auto max-w-md space-y-6 p-8">
      <h1 className="text-2xl font-bold">Provider sign up</h1>
      <p className="text-sm text-[var(--viz-ink-2)]">Demo only: no password. Your email identifies the practice.</p>
      <form onSubmit={submit} className="space-y-4">
        {(["name", "email", "practice"] as const).map((k) => (
          <label key={k} className="block">
            <span className="text-sm capitalize">{k}</span>
            <input className="mt-1 w-full rounded-md border border-black/15 p-2" required={k !== "practice"} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
        <button disabled={busy} className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-50">{busy ? "Creating…" : "Create"}</button>
      </form>
    </main>
  );
}
