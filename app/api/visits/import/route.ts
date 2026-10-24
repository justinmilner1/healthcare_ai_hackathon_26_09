// POST /api/visits/import  { csv, providerId?, commit? }  -> a day of visits in one go (design §2.2).
// Owner: identity.
//
// Two calls, one route, because the preview and the import have to agree about every row:
//   commit false (the default)  -> { columns, ignored, rows: [{ line, name, visit?, errors }] , valid, invalid,
//                                  `inviteFaults` }
//   commit true                 -> the same rows and the same `inviteFaults`, plus `created` per row and the
//                                  ids of what was written
// Staff paste or pick a file, read the preview, then press the button; nothing is written until they do.
//
// `inviteFaults` is what staff read when the invites those rows asked for cannot be sent by this deployment
// at all (T111). It is on *both* responses, because the preview is the screen the decision is made on and
// T135 found it the only one of the two that could not say so: an import is a day of patients, so the fact
// arriving after 25 rows are written arrives after the only moment anyone could have acted on it. The
// answer costs a read of the environment and no network call (lib/notify.ts `inviteFaults`), so the preview
// can afford it exactly as the commit path can.
//
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
import { inviteFaults } from "@/lib/notify";
import { intakeLink } from "@/lib/sms";
import { MAX_CSV_ROWS, parseVisitCsv, type VisitDraft } from "@/lib/visitIntake";
import { importVisits, type CreatedVisit } from "@/lib/visitStore";

/** 500 rows of the widest plausible line, with room to spare. A bigger body is refused before it is parsed:
 *  this is a day's appointments, and anything larger is a mistake worth naming (§9.1 is the file-upload cap). */
const MAX_CSV_BYTES = 512 * 1024;

/** One created visit as this route answers with it: the ids and the token, and not the row facts
 *  `createVisit` also reads for the invite decision. See the call site below. */
const withoutReach = (v: CreatedVisit) => ({ visitId: v.visitId, patientId: v.patientId, token: v.token, patientReused: v.patientReused });

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

  const creatable = parse.rows.filter((r): r is typeof r & { draft: VisitDraft } => Boolean(r.draft));

  // T135 The preview's half of the same question, asked about the rows that *would* be created: a row the
  // parser refused is not an invite anybody is promising. Nothing is written here — `importVisits` and the
  // `enqueue` loop are both below, inside the commit branch — and nothing has to be: the senders answer
  // from the environment.
  if (body.commit !== true) {
    return NextResponse.json({
      ...preview,
      committed: false,
      inviteFaults: inviteFaults(creatable.map((r) => r.draft.channel)),
      rows: parse.rows.map((r) => ({ line: r.line, name: r.name, visit: r.draft, errors: r.errors, warnings: r.warnings })),
    });
  }

  const outcomes = await importVisits(me, provider.id, creatable.map((r) => ({ line: r.line, draft: r.draft })));
  const byLine = new Map(outcomes.map((o) => [o.line, o]));

  // One invite job per created visit that has consent, enqueued after the rows are in: the same job, the same
  // idempotency key and the same single drain as /api/book, so a 25-row import is 25 queued sends and not 25
  // SES round trips inside this request (§3.4).
  //
  // T111 And the same question /api/book asks, once per distinct answer rather than once per row: a file of
  // 25 emailed invites in a deployment with no email backend is one fact about the deployment, not 25. The
  // jobs are still queued, because they are what write the delivery rows §8.3's dashboard reads.
  const invited: string[] = [];
  for (const row of creatable) {
    const created = byLine.get(row.line)?.created;
    if (!created || row.draft.channel === "none") continue;
    invited.push(row.draft.channel);
    await enqueue({ kind: "notify.invite", payload: { visitId: created.visitId }, idempotencyKey: `notify.invite:${created.visitId}` });
  }
  nudge(after);

  return NextResponse.json({
    ...preview,
    committed: true,
    created: outcomes.filter((o) => o.created).length,
    // The rows the database really took, which is narrower than the preview's forecast: a row it refused
    // asked for no invite in the end, so it contributes no sentence about one.
    inviteFaults: inviteFaults(invited),
    rows: parse.rows.map((r) => {
      const outcome = byLine.get(r.line);
      return {
        line: r.line,
        name: r.name,
        visit: r.draft,
        warnings: r.warnings,
        // A row the database refused joins the rows the parser refused, so the screen has one list to read.
        errors: outcome?.error ? [...r.errors, outcome.error] : r.errors,
        // `reach` is dropped: it carries the patient's own phone and address for the invite decision
        // (lib/visitStore.ts `InviteReachRows`, T145), and this preview answers with ids and a link. The
        // bulk path's own sentence about the invites is `inviteFaults` above, one per reason (T135).
        created: outcome?.created ? { ...withoutReach(outcome.created), link: intakeLink(outcome.created.token) } : null,
      };
    }),
  });
}

export const POST = withRoute("POST /api/visits/import", postHandler);
