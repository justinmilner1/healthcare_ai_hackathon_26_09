// POST /api/visits/import  { csv, providerId?, commit? }  -> a day of visits in one go (design §2.2).
// Owner: identity.
//
// Two calls, one route, because the preview and the import have to agree about every row:
//   commit false (the default)  -> { columns, ignored, rows: [{ line, name, visit?, errors }] , valid, invalid }
//   commit true                 -> the same rows, plus `created` per row and the ids of what was written
// Staff paste or pick a file, read the preview, then press the button; nothing is written until they do.
// §2.2's "per-row errors" is the whole point: one unreadable line out of 25 must not cost the other 24.
//
// Importing is booking, so it is the same capability as /api/book (`visits:create`, §5.2) and the same
// practice scoping: the rows land in the caller's practice, and the consent on each is recorded against the
// caller (lib/visitStore.ts), never against a name in the file.
//
// Thin, as AGENTS.md asks: parseVisitCsv is lib/visitIntake.ts and every write is lib/visitStore.ts.

import { after, NextResponse } from "next/server";
import { requireCapability, requireMemberInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { intakeLink } from "@/lib/sms";
import { MAX_CSV_ROWS, parseVisitCsv, type VisitDraft } from "@/lib/visitIntake";
import { importVisits } from "@/lib/visitStore";

/** 500 rows of the widest plausible line, with room to spare. A bigger body is refused before it is parsed:
 *  this is a day's appointments, and anything larger is a mistake worth naming (§9.1 is the file-upload cap). */
const MAX_CSV_BYTES = 512 * 1024;

async function postHandler(req: Request) {
  const me = await requireCapability("visits:create");
  const body = (await req.json().catch(() => ({}))) as { csv?: unknown; providerId?: string; commit?: unknown };

  if (typeof body.csv !== "string" || !body.csv.trim()) return NextResponse.json({ error: "Paste or choose a CSV file first." }, { status: 400 });
  if (body.csv.length > MAX_CSV_BYTES) {
    return NextResponse.json({ error: `That file is too big for one import. It holds a day of visits — at most ${MAX_CSV_ROWS} rows.` }, { status: 413 });
  }

  const parse = parseVisitCsv(body.csv);
  const provider = body.providerId && body.providerId !== me.id ? await requireMemberInPractice(body.providerId, me) : me;

  // A whole-file problem (no header, no rows, too many rows) is still a 200 with the reason in it: the screen
  // shows it where the preview would have been, which is where the person is looking.
  const preview = {
    columns: parse.columns,
    ignored: parse.ignored,
    error: parse.error ?? null,
    valid: parse.rows.filter((r) => r.draft).length,
    invalid: parse.rows.filter((r) => !r.draft).length,
  };

  if (body.commit !== true) {
    return NextResponse.json({ ...preview, committed: false, rows: parse.rows.map((r) => ({ line: r.line, name: r.name, visit: r.draft, errors: r.errors })) });
  }

  const creatable = parse.rows.filter((r): r is typeof r & { draft: VisitDraft } => Boolean(r.draft));
  const outcomes = await importVisits(me, provider.id, creatable.map((r) => ({ line: r.line, draft: r.draft })));
  const byLine = new Map(outcomes.map((o) => [o.line, o]));

  // One invite job per created visit that has consent, enqueued after the rows are in: the same job, the same
  // idempotency key and the same single drain as /api/book, so a 25-row import is 25 queued sends and not 25
  // SES round trips inside this request (§3.4).
  for (const row of creatable) {
    const created = byLine.get(row.line)?.created;
    if (!created || row.draft.channel === "none") continue;
    await enqueue({ kind: "notify.invite", payload: { visitId: created.visitId }, idempotencyKey: `notify.invite:${created.visitId}` });
  }
  nudge(after);

  return NextResponse.json({
    ...preview,
    committed: true,
    created: outcomes.filter((o) => o.created).length,
    rows: parse.rows.map((r) => {
      const outcome = byLine.get(r.line);
      return {
        line: r.line,
        name: r.name,
        visit: r.draft,
        // A row the database refused joins the rows the parser refused, so the screen has one list to read.
        errors: outcome?.error ? [...r.errors, outcome.error] : r.errors,
        created: outcome?.created ? { ...outcome.created, link: intakeLink(outcome.created.token) } : null,
      };
    }),
  });
}

export const POST = withRoute("POST /api/visits/import", postHandler);
