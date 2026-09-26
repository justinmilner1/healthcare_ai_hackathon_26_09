"use client";

// Patient booking + opt-in. Calls POST /api/book. Shows the link if Twilio is not configured.
// Owner: Justin (texting).

import { useState } from "react";

export default function BookPage() {
  const [form, setForm] = useState({ name: "", phone: "", optIn: true });
  const [result, setResult] = useState<{ link: string; sms: { sent: boolean; error?: string } } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    setResult(await res.json());
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-md p-8 space-y-6">
      <h1 className="text-2xl font-bold">Book your endo visit</h1>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm">Name</span>
          <input className="mt-1 w-full rounded border p-2" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm">Mobile number</span>
          <input className="mt-1 w-full rounded border p-2" placeholder="+14155551234" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.optIn} onChange={(e) => setForm({ ...form, optIn: e.target.checked })} />
          Text me a link to get ready for my visit with Sweetie
        </label>
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Booking…" : "Book"}
        </button>
      </form>

      {result && (
        <div className="rounded border bg-green-50 p-4 text-sm">
          <p className="font-medium">Booked.</p>
          {result.sms.sent ? <p>Check your phone for a text from the office.</p> : <p>Open your Sweetie link: <a className="underline" href={result.link}>{result.link}</a></p>}
          {!result.sms.sent && result.sms.error && <p className="mt-1 text-gray-500">({result.sms.error})</p>}
        </div>
      )}
    </main>
  );
}
