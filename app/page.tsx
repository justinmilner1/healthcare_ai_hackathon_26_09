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
        <Card href="/book" title="Book a visit" body="Patient books, opts in, gets a text with their Sweetie link." />
        <Card href="/provider/signup" title="Provider sign up" body="Create a provider and see your patient list." />
      </section>

      <section className="rounded-lg border p-4 text-sm text-gray-600">
        <p className="font-medium text-gray-800">Dev shortcuts</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Run <code>npm run seed</code> to create a demo provider and patient with sample data loaded.
          </li>
          <li>The seed prints the Sweetie link, the provider page, and the patient page.</li>
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
