# The audit log

Design §4.8 and §10.2. Code: `lib/auditLog.ts` (pure), `lib/auditStore.ts` (database), `app/api/audit`,
`app/provider/audit`. Owner: compliance.

> §10.2 Audit log: every read of a visit's intake, summary, messages, or uploads by a user, every
> patient-link verification, every send, every deletion. Readable by practice admins on an audit page;
> exportable.

This is not the application log. `lib/log.ts` is operational, goes to stdout and CloudWatch, and is forbidden
from holding anything about a patient (§10.3). The audit log is a table in Postgres, lives with the practice,
and is the record of who touched whose data. Both exist; neither does the other's job.

`lib/audit.ts`, confusingly close in name, is the **dependency** audit gate (§10.8). It is unrelated.

## What writes a row

| Action | Written where | Actor |
|---|---|---|
| `intake.read`, `messages.read`, `summary.read`, `uploads.read` | `GET /api/patient/[id]` when a provider reads it; `POST /api/sour` with a question | the signed-in user |
| `patient.verified` | `POST /api/verify`, when a six-digit code is accepted (T08, §5.3) | the patient |
| `invite.sent`, `code.sent`, `summary.sent` | `lib/jobHandlers.ts`, after the send returns | the job (`system`) |
| `upload.deleted`, `summary.deleted` | `DELETE /api/upload` | the patient |

One row per **part** of a visit, and only for the parts that were really in the response: a visit with no
uploads records no `uploads.read`. `messages` is the transcript as a provider gets it — `Visit.notes`, the
chat rendered for Sour by `renderNotes` — because that is the patient's own account of their week either way.

The verification row is the code, not the link. Since T08 a token on its own opens the code screen and
nothing else (§2.3), so resolving one is not a verification and records nothing; what §10.2 is asking about
is the moment a code from the visit's own phone or email is accepted and the browser gets a 24-hour session.
That route writes it through `recordPatientVerified`, so it speaks the same vocabulary as the rest of the
trail and its detail goes through the gate below. T14 adds `patient.deleted` and the nightly
`retention.swept` (§10.4, §10.5).

### What deliberately does not write a row

The dashboard's worklist (`GET /api/provider`) is not a read of a visit's intake, summary, messages or
uploads: it is the practice's own list of who is where in the flow, loaded on every page view by everyone who
works there. Auditing it would bury the rows that matter under rows that say nothing.

Sign-in links are not recorded here either. They are Auth.js's own event and belong to a provider's identity,
not to a patient's data.

### Repeated reads

The Sour page polls `GET /api/patient/[id]` up to twenty times while a summary is generated, and a clinician
opens the same visit before and during an appointment. Identical rows inside `READ_COALESCE_MS` (one minute)
become one: the row's `at` moves forward and `detail.count` says how many. Nothing is lost — the row still
says who, what, how many and when it last happened — and the page stays a record a person can read.
Verifications, sends and deletions are never coalesced: each is its own event, and a second verification is a
second browser, which is exactly what an admin would want to see twice.

A write never fails the request it belongs to. The thing being recorded has already happened by then, so
`recordAudit` catches, writes `audit_write_failed` to the application log, and returns.

## `detail` holds no PHI

§4.8 says `detail` is "JSON without PHI". Two gates in `auditDetail`, because an allow-list of field *names*
would still let `kind: patient.name` through:

1. **Names.** Only `AUDIT_DETAIL_FIELDS` survive. Anything else is dropped and reported by name in
   `droppedFields`, never by value — so a caller passing the wrong thing is visible on the audit page.
2. **Shapes.** A value has to be a boolean, a finite number, or a short token with no spaces that is not
   shaped like a phone number or an address. Free text is not representable in this column at all.

`lib/auditLog.test.ts` asserts it directly: every value the app holds about a patient, offered under both its
own name and an allow-listed one, and absent from the JSON. `e2e/audit.spec.ts` asserts the same thing against
the real table, in the CSV export and in the JSON the page reads.

The actor's **name** is not stored either. The row keeps an opaque user id; the page joins it against the
practice's own users when it reads them, which is why a user who has since left shows as "Former colleague".

## Reading it

`/provider/audit`, admin only — `audit:read` in `lib/access.ts`, which is §10.2's "readable by practice
admins" in those words. The page filters by action, by who, by visit or upload id and by date, and exports the
rows on screen with the Export CSV button (`GET /api/audit?...&format=csv`). The export quotes to RFC 4180 and
prefixes a cell that starts with `=`, `+`, `-` or `@` with an apostrophe, so a spreadsheet does not run a
colleague's name as a formula.

Rows are never edited or deleted from the outside: no route offers it, and the page has no button for it.
