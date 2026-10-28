# T183 — the brief and the sheet stop telling the office to send a link that will not open

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where no email or
SMS backend is configured (§11.3, §6.3). That is what lets the gate photograph the bug at all: with no
sender behind SMS, a patient whose only detail is a mobile number has nowhere for a six-digit code to
arrive, so every channel between them and the code their link opens on is closed (`codeReach`,
`lib/notify.ts`).

Nine frames, in three pairs plus one. The first pair is the ticket, the second is the §7.4 sheet that
carries the same sentence onto paper, the third is the direction that was always right and had to stay
word for word, and the last is the screen the ticket was found on.

## The brief's empty state (§2.6)

| File | What it shows |
|---|---|
| `desktop-sour-waiting-no-handover.png` | **The ticket.** A visit booked for a patient no code can reach, nothing pressed: *"Nothing to summarize until the patient has talked to Sweetie. **Sending the link again will not open it for this patient.**"* The second sentence used to read *"Send the link again if they have not opened it."* — an instruction that rests on the link opening. |
| `mobile-sour-waiting-no-handover.png` | The same card at 375px (§6.5). Its own frame because the phone wraps the pair onto two lines inside a card that fills most of the screen, which is the whole of what a clinician reads there. |

## The printed one-pager (§7.4)

| File | What it shows |
|---|---|
| `desktop-print-empty-no-handover.png` | The same visit's sheet, server-rendered, so what is in the picture is what would print: *"The patient has not talked to Sweetie or shared any data for this visit. **Sending the link again will not open it for this patient.**"* The lead sentence is the sheet's own and differs from the screen's; the one after it is the same string, out of `lib/sourState.ts`. |
| `mobile-print-empty-no-handover.png` | The sheet at 375px. Whole-document on both projects — there is nothing to summarize, so it is shorter than a phone screen (T109). |

## The direction that must not move (criterion 3)

| File | What it shows |
|---|---|
| `desktop-provider-sour-not-started.png` | **The half that keeps the rule honest.** The seeded demo practice's own empty visit, where the patient has an address on file and this gate has a mailbox behind it — so a code *can* reach them and *"Send the link again if they have not opened it."* is exactly the right instruction. Unchanged, to the word. A fix that simply withdrew the sentence everywhere would satisfy the two frames above and say nothing; this is the frame that shows it does not. |
| `mobile-provider-sour-not-started.png` | The same reachable card at 375px. |
| `desktop-provider-print-no-clinician.png` | And the reachable direction on paper, on the sheet `e2e/print.spec.ts` already took for T171: the instruction intact under "Nothing to summarize yet". |

## The screen the ticket was found on

| File | What it shows |
|---|---|
| `desktop-sour-invite-no-handover.png` | **The disagreement, resolved, in the frame that held it.** T179's own picture, retaken: the invite note after **Send link** — *"No invite sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office. Handing the link over will not get this patient in either."* — and, four inches under it in the same screenful, the empty state that used to answer the opposite. Both sentences are now about the same fact. Compare `docs/screenshots/tickets/t179/desktop-sour-invite-no-handover.png`, the same screen one ticket earlier, which is where this was filed from. |
| `mobile-sour-invite-no-handover.png` | The same screen at 375px. |

## Where the decision lives

`PatientBundle.codeCanReach` is `canHandOver`'s answer (`lib/notify.ts`), settled once in `loadBundle`
(`lib/bundle.ts`) off the patient row `POST /api/invite` already reads for the note in the last frame — the
same four facts, the same row, so the note and the card under it cannot answer one patient differently.
`waitingOnPatientNote` (`lib/sourState.ts`) is the one wording both surfaces print, beside
`visitNotStarted` and `narrativeNote`, which are the other two decisions these same two screens share.

What the withdrawn sentence deliberately is **not**: it is not `NO_HANDOVER_SENTENCE`, because nothing on
this card ever offered to hand the link over — it takes back an *instruction*, not an offer — and it is not
the dashboard row's `NO_CODE_CAN_REACH` either, whose *"— call them"* is the remedy, and the remedy belongs
to the screen that owns the visit's contact details (the T170 split). Like everything else in that module,
it names no variable, no backend and no administrator (§3.7, §10.6).
