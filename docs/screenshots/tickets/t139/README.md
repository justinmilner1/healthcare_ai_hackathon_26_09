# T139 — Sweetie's Dexcom offer promised the doctor a week

**There is no frame of the turn this ticket fixes, and the reason is not the deployment.** The two
sentences T139 is about are the `target.kind === "upload"` branch of `speakSystem` and of `scripted` in
`lib/sweetie.ts`, and **nothing in the running product produces that target any more.** `nextTarget` is
the only thing that builds a `Target` for a turn (`lib/sweetieTurn.ts:126` and `:154`), and it returns
`field` or `wrap` and never `upload`:

```ts
// lib/sweetie.ts, nextTarget
if (state.flagged) return { kind: "wrap" };
if (state.questionsSkipped) return { kind: "wrap" };
for (const f of defs) if (f.required && …) return { kind: "field", def: f };
for (const f of defs) if (!f.required && … && state.turns < 6) return { kind: "field", def: f };
return { kind: "wrap" };
```

The `upload` arm left the question flow in `aa8a331` ("Sweetie: two exchanges for the demo",
2026-09-26): *"No data question: the optional panel stays, and the goodbye mentions it in one clause when
nothing was shared."* Design **§2.5** is written the same way — "The two-question intake as built, voice
or text. **Optional data panel**: Dexcom connect, Dexcom CSV, Timeline JSON, WHOOP CSV" — so the code and
the design agree, and the sentence is asked by the panel rather than by Sweetie.

So **the ticket's steps to reproduce cannot be walked** (step 3, "Her next message is the
`t.kind === "upload"` line"), and the definition of done's "the suite already reaches this state offline"
is not true of this tree. That is a fact about the branch and not about this run: no deployment,
credential or viewport brings the turn back, and it is the one thing in the ticket this run could not
do. `docs/screenshots/tickets/t134/README.md` and `t125/README.md` record the same shape for the states
they could not shoot.

The fix still belongs on `main` as written: the strings are real, they are reachable through the two
exported functions, and every criterion that is about *the words* is met and now pinned by tests. Whether
the offer should come back as a turn at all is a product decision for the issue, not for this run.

## What the two sentences said, before and after

| Where | before | after |
|---|---|---|
| `speakSystem`, the `upload` goal (the model's instruction) | "…they can add it with the optional Dexcom button on this page, and it helps the doctor see **the week in numbers**." | "…and it helps the doctor see **their glucose readings**." |
| `scripted`, the Dexcom offer (§6.3, what every offline deployment says) | "…you can add it with the Dexcom button and your doctor can see **the week in numbers**." | "…and your doctor can see **your glucose readings**." |

"your glucose readings" is the wording T123 and T132 settled on for the same presumption on the rendered
path (`lib/dexcomHint.ts`'s unconfigured branch, `summaryDataInvite`'s empty state). `parseClarityCsv`
keeps every `EGV` row it is handed and clips nothing, so `data/fixtures/clarity_window.csv` — 84 readings
inside one morning — is a supported answer to that offer, and the span is the patient's to choose.

## What stands in for the picture

Five tests in `lib/sweetie.test.ts`, all on the strings themselves rather than on a screen:

- **`no upload offer promises a span, scripted or in the prompt (T139, §2.5)`** — all three upload
  targets, both halves, over `week`, `7 days`, `seven days`, `last N days` and `fortnight`; and the two
  Dexcom sentences are also asserted to still *say* what the upload buys, so this cannot pass by going
  silent. Checked by reverting both sentences to "the week in numbers": it fails, naming the half.
- **`the Dexcom offer still reads as optional and still names its control (T139)`** — §2.5's optionality
  and the system prompt's own name-not-position rule, on both halves.
- **`the wrap-up's Dexcom clause names no span either, and still offers the button (T139)`** — the
  clause the ticket asked be left alone and checked; also that it is absent once glucose is in.
- **`the prompt's own §6.5 rule reaches the model, not just the module (T139)`** — the placement rule on
  the string the model is handed, for every target.
- **`the sandbox branches T134 settled are untouched by the span sweep (T139)`** — `SANDBOX_CONNECT_HELP`
  and the wrap's sandbox clause, unchanged.

The prompt side is testable at all because `speak`'s developer message moved into an exported
`speakSystem`, which is the shape `lib/prompts.ts` already uses for Sour's prompts: a pure builder, read
by a test that builds it. `speak` is now the sandbox short-circuit plus one `ask`.

## The PNGs here, and what they are

The chat at both widths from the `bash scripts/agent-check.sh` run that passed on the tree these commits
landed as. They are **not** the offer turn — there is none — they are the chat screens `lib/sweetie.ts`
actually drives offline, which is the module this ticket changed: `e2e/flows.spec.ts`'s patient flow, on
the turn after both questions are answered, where the scripted wrap plays and the Dexcom clause of the
`wrap` goal would appear if a model were answering.

| File | What it shows |
|---|---|
| `desktop-sweetie-start.png` | The opening message, which is the one place a patient is told about the three optional buttons (`greeting`, T105). It names the controls and no span, and this ticket left it alone. |
| `desktop-sweetie-done.png` | The finished check-in: both answers in, the completion card, no Dexcom sentence anywhere — because offline the wrap is `scripted`'s fixed goodbye, which has never had one. |
| `mobile-sweetie-done.png` | The same turn at 375px (§6.5), the second of the two widths the definition of done asks for. |
| `mobile-375-sweetie-answered.png` | The phone transcript mid-check-in, one answer in, which is the closest frame in the suite to "the turn that makes the offer" — in the product that turn is the second question instead. |

## Out of scope, and unchanged

Exactly as the ticket lists them: `lib/dexcomHint.ts:103`'s "Your last 7 days of readings are imported."
(a span `lib/dexcom.ts` really requests, pinned by `lib/dexcom.test.ts`), `lib/uploads.ts:163-165` (advice
about what to export, and a fact about what `lib/location.ts` keeps), `app/page.tsx` (marketing copy, per
T132), the wrap-up's own Dexcom clause (changed in no way; now asserted), and the two sandbox branches
T134 settled.
