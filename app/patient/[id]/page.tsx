"use client";

// Patient view of their own summary. Owner: Justin. Uses GET /api/patient/[id].

import { use, useEffect, useState } from "react";
import GlucoseChart from "@/components/GlucoseChart";
import type { PatientBundle } from "@/lib/types";

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [bundle, setBundle] = useState<PatientBundle | null>(null);

  useEffect(() => {
    fetch(`/api/patient/${id}`).then((r) => r.json()).then(setBundle);
  }, [id]);

  if (!bundle) return <main className="p-8 text-gray-500">Loading…</main>;
  const s = bundle.patientSummary;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Your week, {bundle.patient.name.split(" ")[0]}</h1>
      <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} />
      {!s ? (
        <p className="text-gray-500">Your summary will appear here once your doctor&apos;s office has prepared it.</p>
      ) : (
        <>
          <p className="text-lg">
            You were in range <strong>{Math.round(s.timeInRange * 100)}%</strong> of the time.
          </p>
          <section>
            <h2 className="font-semibold">What your data showed</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5">{s.patterns.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </section>
          <section>
            <h2 className="font-semibold">Things you might ask your doctor</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5">{s.questions.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </section>
        </>
      )}
      <p className="text-xs text-gray-400">This is a summary of your own data, not medical advice.</p>
    </main>
  );
}
