# T219 — the audit page stops claiming more than its own table shows

Cites design **§10.2** (the audit log and the admin audit page) and **§10.7** (the HIPAA checklist's
*integrity* item). The frames are from the `bash scripts/agent-check.sh` run that landed this ticket
(exit 0, 1445 unit tests, 333 e2e passed / 13 skipped, whole check 19m45s).

## What the lede used to say

```
Every read of a visit's answers, chat, uploads or summary; every patient link accepted; every
message sent; every deletion. Admins only. Entries are never edited or removed, and carry no
patient details — only who, what, and when.

| When | Who | What | On | Detail |            ← five columns, under three nouns
```

Two claims, both contradicted by the table directly beneath them in the same frame:

- **"Entries are never edited."** `recordVisitRead` passes `coalesceMs: READ_COALESCE_MS`, so every §10.2
  read repeated inside a minute goes through `absorbed` in `lib/auditStore.ts`, which **updates a row
  already on the record** — moving its `at` forward and rewriting its `detail` with a higher `count`. Those
  are both of the columns the sentence went on to name. The module's own header documents this as intended,
  so the code and its comment agreed with each other and only the page disagreed with both.
- **"only who, what, and when."** The table has five columns. The two it left out are `On` — which the
  page's own filter bar offers to search by, `Visit or upload id` — and `Detail`.

## The frames

| File | What to read |
|---|---|
| `desktop-provider-audit.png` | The corrected lede above the five columns, unfiltered. The second sentence now enumerates the columns themselves — `when, who, what, the id of what was touched and a few counts and constants` — and the third says what the store does to a row that is already there: `A repeated identical read within a minute is counted on the row already there, whose time becomes the latest of them; verifications, sends and deletions are each their own row.` The `Uploaded data read` row below it carries `count: 1`, which is that sentence's subject. |
| `desktop-provider-audit-deletion.png` | The frame the ticket was filed on, filtered to `Patient data deleted`. Its `On` cell is `PATIENT cmvzfmmg…`, which is why the lede says *the id of what was touched* rather than naming the visit: §10.2's subject is a visit, but a deletion row is against a patient and a sweep row against a practice. |
| `mobile-provider-audit.png` | The same lede at 375px (§6.5). Nine lines, nothing clipped. |
| `mobile-provider-audit-deletion.png` | The row stacked into labelled lines. The labels are the same `AUDIT_COLUMNS` the headers and the sentence come from, so the phone cannot show a column the sentence has not named either. |

## Where the sentence lives now

`lib/auditLog.ts`, which is where this page's vocabulary already was — the T205 pattern, and the reason this
went uncaught for as long as it did: a literal in the JSX is the one thing §12.1 cannot ask about. It is
built from the only two things that decide it, so neither can drift from it again:

- `auditCoalescingSentence` branches on the window. `READ_COALESCE_MS` moved into the pure module for this
  (the page is a client component and may not import the store, which takes it from there), and setting it
  to `0` makes the sentence say *every event is its own row, and a row is never changed once it is written*
  — the only setting under which the old wording was true.
- `auditRowSentence` enumerates `AUDIT_COLUMNS`, which is also where the table's `<th>` and its per-row
  `data-label`s come from. The cell renderers are a `Record` over the header union, so a column added to the
  list is one the page will not compile without.

What is **not** claimed is tamper resistance: a row is an ordinary Postgres row and anyone with the database
password can change one (`docs/COMPLIANCE.md`, risk `R4`, whose *nothing in the app writes to it twice* this
ticket also corrected). The lede speaks only for what the app itself does.

Out of scope, and still open: recording the first access time as well as the last. When N reads coalesce the
surviving `at` is the **last** of them, so the time of the first access in that window is not on the record.
That is a real §10.2/§10.7 question and deserves its own argument; this ticket only made the page say so.
