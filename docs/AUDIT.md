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
| `patient.consent_accepted`, `patient.consent_declined` | `POST /api/consent`, when the §2.4 screen is answered (T09, T51) | the patient |
| `invite.sent`, `code.sent`, `summary.sent` | `lib/jobHandlers.ts`, after the send returns | the job (`system`) |
| `upload.deleted`, `summary.deleted` | `DELETE /api/upload` | the patient |

One row per **part** of a visit, and only for the parts that were really in the response: a visit with no
uploads records no `uploads.read`. `messages` is the transcript as a provider gets it — `Visit.notes`, the
chat rendered for Sour by `renderNotes` — because that is the patient's own account of their week either way.

The verification row is the code, not the link. Since T08 a token on its own opens the code screen and
nothing else (§2.3), so resolving one is not a verification and records nothing; what §10.2 is asking about
is the moment a code from the visit's own phone or email is accepted and the browser gets a 24-hour session.
That route writes it through `recordPatientVerified`, so it speaks the same vocabulary as the rest of the
trail and its detail goes through the gate below.

The consent rows are §2.4's screen, which is not one of §10.2's four categories and is recorded anyway: every
other row about this visit's data exists because the patient said yes first, and an admin asked to stand
behind that has to be able to see it. One row per visit per answer — accepting twice keeps the first time and
writes nothing (`lib/consent.ts` `recordConsent`), and declining is the moment a verified session was ended on
the patient's own say-so, so its detail is `rows`: how many sessions went with it. Both go through
`recordPatientConsent` (`lib/auditStore.ts`), like the verification above; before T51 this one route wrote
straight to the table, and the result was a row the page could neither name nor filter.

Deletions are four different events and each has its own action. `upload.deleted` and `summary.deleted` are
the patient withdrawing one upload from their own link. `patient.deleted` is §10.5's staff action — one row
for the whole person, written against the staff member who asked for it even though a job carried it out,
because somebody pressed it. `retention.swept` is §10.4's nightly job, one row per visit it cleared, with the
job as the actor: nobody pressed anything. All three carry counts and nothing else (`visits`, `uploads`,
`turns`, `summaries`, `objects`, `orphans`, `dexcom`, `days`), so the trail says how much went and never what
it was. `orphans` above zero is the one to read twice: it means the rows are gone and some bytes were left in
the object store, and the page shows it as a warning rather than one more count for exactly that reason.

`storage.orphans_purged` is the fourth, and it is what closes an `orphans` row out (T70). A refused prefix
goes on `StorageOrphan`, which outlives the `Visit` whose id it is built from; the nightly sweep and the next
press of *Delete data* both walk it, and when the bytes finally go that is a deletion like any other. One row
per practice per pass, against the job, carrying `prefixes`, `objects` and `orphans`. A pass that removed
nothing writes nothing — the backlog not clearing is a log line (`storage_orphans_retried`) and an unmoving
`StorageOrphan` row, not a deletion.

### What deliberately does not write a row

The dashboard's worklist (`GET /api/provider`) is not a read of a visit's intake, summary, messages or
uploads: it is the practice's own list of who is where in the flow, loaded on every page view by everyone who
works there. Auditing it would bury the rows that matter under rows that say nothing.

Sign-in links are not recorded here either. They are Auth.js's own event and belong to a provider's identity,
not to a patient's data.

### Repeated reads

The Sour page polls `GET /api/patient/[id]` up to twenty times while a summary is generated, and a clinician
opens the same visit before and during an appointment. Identical rows inside `READ_COALESCE_MS` (one minute)
become one: the row's `at` moves forward and `detail.count` says how many. Verifications, sends and deletions
are never coalesced: each is its own event, and a second verification is a second browser, which is exactly
what an admin would want to see twice.

**The window is measured from the row's first read, and the row carries both ends of the span** (T220). A row
has two times on it: `firstAt`, written once when the row is created and never again, and `at`, the latest
event counted on it. `absorbed` looks for a candidate by `firstAt >= now - READ_COALESCE_MS`, so
`at - firstAt` can never exceed the window, and the `When` cell prints the span beneath the time — *"3 reads
over 42 seconds, from 14:08:31"* — while the CSV carries `firstAt` as a column of its own.

That is a change from how this worked until T220, and the old behaviour is worth stating because the bound is
the whole point. The lookup used to be `at >= now - READ_COALESCE_MS` and the absorb moved `at` to now, so the
window was measured from the *last* read it had absorbed: the cursor followed the polling and the window slid
with it. A read arriving every 59 seconds absorbed into the same row for ever. Measured on a 2-second window
with real 1.5-second waits, eight reads became one row standing for 10.6 seconds — 5.3 times the window the
page described. There was no cap, on elapsed time or on `count`, and nothing on the row said how long it
covered, so §10.2's "who read this visit and when" had an answer of unbounded vagueness and §10.7's integrity
item could not be met by it. `lib/auditStore.test.ts` is that case, scaled to run in seconds.

What is still a trade-off, narrowed rather than removed: the times of the reads *between* the first and the
last are not on the record. The row says there were N of them and that they all fell inside one window of a
known length, which is what the page and this document now claim and no more.

`READ_COALESCE_MS` is declared in `lib/auditLog.ts`, not in the store that applies it, because the sentence
over the audit table is built from it: `auditCoalescingSentence` describes counting exactly when the window
is positive, and names that window twice — as the gate a repeated read has to fall inside *of the first* read,
and as the ceiling no row may exceed. Set the constant to 30 seconds and the page says 30 seconds in both
places. `auditRowSpan` and `auditSpanWords`, in the same module, decide what the `When` cell prints about a
row's span and whether there is one to print, so the cell cannot claim something the sentence above it does
not. A client component may not import `lib/auditStore.ts`, and one constant in two places is how
the page came to claim the opposite of what the store does.

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
The one write the app makes to a row already on the record is the read coalescing above, which the lede
states rather than denying, and which touches two of the row's columns and never `firstAt`. That lede — §10.2's scope, what a row carries, and what coalescing does to a row — is
`auditLede` in `lib/auditLog.ts`, and the table's headers and its per-row mobile labels are the
`AUDIT_COLUMNS` the same sentence enumerates. None of it is a literal in the JSX: a claim the unit suite
cannot ask about is a claim nothing holds (§12.1), which is how the old one survived five columns being
described as three.
