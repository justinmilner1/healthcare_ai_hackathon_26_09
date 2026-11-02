# T220 — a coalesced audit row says what span it stands for

Cites design **§10.2** (the audit log and the admin audit page) and **§10.7** (the HIPAA checklist's
*integrity* item). The frames are from the `bash scripts/agent-check.sh` run that landed this ticket
(exit 0; `e2e` 15m13s, whole check 17m20s, no failed assertion and no serial re-run).

This is the ticket T219 left open at the end of its own README — *"recording the first access time as well
as the last … deserves its own argument"* — plus the half the reviewer found while reading `absorbed` for
it, which was the more serious one.

## What was wrong

`absorbed` in `lib/auditStore.ts` looked for a row to count a repeated read on by `at >= now -
READ_COALESCE_MS`, and on a hit set `at: new Date()`. **The cursor moved to now**, so the window was
measured from the last read absorbed rather than from the row's first, and slid forward with the polling:

```
t=0s    row written              at=0s    count=1
t=59s   at(0s)  >= t-60s? yes    at=59s   count=2
t=118s  at(59s) >= t-60s? yes    at=118s  count=3      ... for ever
```

A clinician's Sour page polling through a 40-minute appointment (§7.2 polls up to twenty times per
generation, and a page left open re-reads) yielded one row with `count` in the dozens and `at` the last
read — describing itself to an admin as a one-minute window, with no cap on elapsed time or on `count`.
Measured with a 2-second window and real 1.5-second waits: eight reads, one row, 10.6 seconds, 5.3x the
window it claimed. §10.2's "who read this visit and when" therefore had an answer of unbounded vagueness.

## What the row carries now

`AuditLog.firstAt`, written once when the row is created and never again. The lookup bounds on it, so
`at - firstAt` cannot exceed `READ_COALESCE_MS`, and both ends are on the screen and in the CSV. A column
rather than a `detail` key or a hard cap, for three reasons: a cap would bound the span and still not say
when the row began; §4.8's shape gate reads an ISO timestamp as phone-shaped and drops it, so `detail`
cannot hold one at all; and only a column becomes a field of its own in the §10.2 export.

## The frames

| File | What to read |
|---|---|
| `desktop-provider-audit-visit.png` | The ticket's subject. `Uploaded data read`, filtered to one visit: the `When` cell reads `11/2/2026, 5:06:30 PM` with **`3 reads over 1 second, from 11/2/2026, 5:06:29 PM`** under it, and `count: 3` in `Detail` beside it. Three `GET /api/patient/[id]` calls a second apart (`e2e/audit.spec.ts`), which is what §7.2's poll does. Before this ticket the same row showed one time and nothing else. |
| `desktop-provider-audit.png` | The corrected lede, unfiltered. The third sentence now names the window twice — *"A repeated identical read within a minute **of the first** is counted on the row already there, which keeps the time it began and shows the span up to the latest of them, **so no row stands for more than a minute**"* — which are the two claims the store could not honour before `firstAt`. It is `auditCoalescingSentence`, built from `READ_COALESCE_MS`, so a store set to 30 seconds says 30 seconds in both places. |
| `mobile-provider-audit-visit.png` | The same row stacked into labelled lines at 375px (§6.5). The span sits inside the `WHEN` block, under the time, on one line and unclipped. |

## Why there is no sixth column

A span is something only a coalesced read has, so a `Covers` column would be empty on nearly every row.
What an admin needed was for the one time in the `When` cell to stop being everything the row says about
when. `auditRowSpan` and `auditSpanWords` in `lib/auditLog.ts` decide the words and whether there is a span
to print at all, next to the sentence over the table that promises the bound — so the cell cannot claim
something the lede has not. `AUDIT_COLUMNS` is unchanged at five, which T219's guard still holds.

## What is still a trade-off

The times of the reads *between* the first and the last are not on the record. The row says there were N of
them and that they all fell inside one window of a known length, and `docs/AUDIT.md` and the page claim no
more than that. Risk `R4` in `docs/COMPLIANCE.md` is unchanged: it is about writes from outside the app —
the database password — and nothing here makes a row harder to edit by hand.
