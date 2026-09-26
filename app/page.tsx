import Link from "next/link";

// Landing. Links to every screen so anyone can reach their page without a booking flow.
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8 space-y-8">
      <header>
        <h1 className="text-4xl font-bold">Sweet Spot 🍬🍋</h1>
        <p className="mt-2 text-lg text-gray-600">
          Sweetie talks to the patient before the visit. Sour hands the endocrinologist a one-page summary.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card href="/provider" title="Practice dashboard" body="Add booked patients, send Sweetie links, see who is ready, open summaries in Sour." />
        <Card href="/demo" title="Demo provider" body="Sign in as Dr. Demo Endo with the seeded sample patient (after npm run seed)." />
      </section>
      <p className="text-sm text-[var(--viz-ink-2)]">
        Patients never visit this site on their own. A booked visit in the practice&apos;s scheduling system creates the patient here and sends a text or email with a presigned link. That link is the patient&apos;s only entry point.
      </p>

      <section className="rounded-lg border p-4 text-sm text-gray-600">
        <p className="font-medium text-gray-800">Dev shortcuts</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Run <code>npm run seed</code> to create a demo provider and patient with sample data loaded.
          </li>
          <li>The seed prints the Sweetie link, the provider page, and the patient page.</li>
          <li>
            <code>POST /api/book</code> is the scheduling-system hook: it creates the patient and sends the invite. The provider page&apos;s Add patient form calls it.
          </li>
        </ol>
      </section>
    </main>
  );
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="rounded-lg border p-4 hover:bg-gray-50">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{body}</p>
    </Link>
  );
}
