# T194 — Sour's system prompt said every placed spike was a place the patient had just left

**There is no frame of the sentence this ticket fixes, and the reason is the mode the check runs in.**
`sourSystem()` is read in exactly one place — `modelNarrator` in `lib/sourRun.ts:286`, where it is the
developer message of an `ask` call. `scripts/agent-check.sh` runs with no `OPENAI_API_KEY`, so `lib/llm.ts`
throws `LLMUnavailable` and `runSour` falls back to `degradedPair`, whose `patterns` and `questions` are
empty by construction (design §6.3, §11.3). The suite's second app server (port 3101, `e2e/degraded.spec.ts`)
has a key set and `OPENAI_BASE_URL` pointed at a closed loopback port, so it reaches the same
`LLMUnavailable` through the network instead of through the missing key. **Either way the prompt is never
sent**, and no screen in the suite can show what the model does with it.

That is a fact about the offline mode the demo and the gate run in, not about this branch. The screens
below are the surfaces the brief feeds — the place the prompt's subject matter is actually rendered — and
they are here because they are what a reviewer can check: the `place context` the prompt now describes is
the same per-row relation the clinician's Place column prints, and the two have to agree.

## What the two sentences said, before and after

| Where | before | after |
|---|---|---|
| `sourSystem()`, the lede that frames the data | "…a per-day table, detected spikes **with the place the patient had just left**, sleep nights labeled by the evening before…" | "…a per-day table, detected spikes whose **\"place context\" names the place the rise was linked to and how the rise sits against the patient's stay there (or says no stop matched)**, sleep nights labeled by the evening before…" |
| `lib/prompts.ts:13`, the file's own comment | "spikes with **the place the patient had just left**, and nights labeled by the evening before." | "spikes with a **\"place context\" — the place the rise was linked to and which of the four relations `relationTo` can put on it, or no match at all** — and nights labeled by the evening before." |

`relationTo` (`lib/sour.ts:353`) returns one of four words per row, or `null`:

| `relationTo` | the row the model reads (`placeContext`) |
|---|---|
| `after leaving` | `after leaving Fixture Cafe at 6:50` |
| `at` | `at Fixture Taqueria (12:15–13:00)` |
| `arrived during the rise at` | `arrived during the rise at Fixture Taqueria (12:40–13:30; weak association — the climb had started before the patient got there)` |
| `during a long stay at` | `during a long stay at Fixture Office (09:00–17:00; weak association)` |
| `null` | `no visit within 30 min` |

"the place the patient had just left" is the first of those five, asserted over all of them — and the
prompt's own "Place matches are temporal associations" paragraph, four lines below the lede, was already
written against all four markings. So the prompt described its input one way and then told the model to
read it another. `"place context"` is the literal column header the brief prints
(`lib/sour.ts:240`), and "the place the rise was linked to" is `matchedPlaceClause`'s own neutral
clause (`lib/spikePlaces.ts:367`), the wording T192 settled on for a set of labels whose
relations are mixed — which is every brief, since the prompt is written once for all of them. So the
prompt and the clinician's caption name a link the same way rather than minting a phrase of its own.

## The seeded week, which is the brief the demo ships

`desktop-provider-sour-chart-caption-placed.png` is the one in this directory worth reading first. Its
Spikes-linked-to-places card is the clinician's rendering of the same five rows the brief hands the model,
and on `npm run seed`'s week they are:

| When | Place column | `spikeVisitRelation` | what `relationTo` puts in the brief |
|---|---|---|---|
| Sun 10:30 PM | `Office · while there` | `during` | `at` or `during a long stay at` |
| Tue 10:45 PM | `Office · while there` | `during` | `at` or `during a long stay at` |
| Sat 1:45 PM | `no matching visit` | — | `null` |
| Sun 1:55 PM | `no matching visit` | — | `null` |
| Fri 7:40 PM | `Home · arrived 10 min after` | `arrived` | `arrived during the rise at` |

**Not one of the five is a place the patient had just left.** The lede this ticket fixes was wrong about
every row of the brief the demo ships, which is the same thing T191 found four inches above that card and
T193 found on the patient's copy of it. The caption over the card already says it the way the prompt now
does — "give the place the rise was linked to, or the peak mg/dL where no place matched" — so the two
sentences a clinician and the model read about one match are finally the same sentence.

## What stands in for the picture

`lib/sour.test.ts`, "every relation the brief can print is one the prompt explains, and none is asserted
of all of them (T194)". It builds each of the four relations from crafted spikes rather than listing them,
asserts the set is four, and requires `sourSystem()` to say what to do with each — so a fifth relation
fails that test instead of going unexplained in the one place the model is reading. The two halves of the
regression are asserted directly: the no-match row is admitted by the lede, and
`the place the patient had just left` appears nowhere in the prompt. Checked by reverting the lede: it
fails on the last assertion.

The paragraph this ticket left alone is the half that was already right (AC3), and it still enumerates
exactly those four words and nothing else — the four `includes` assertions in that test are what now hold
it there.

## The PNGs here, and what they are

From the `bash scripts/agent-check.sh` run that passed on the tree these commits landed as.

| File | What it shows |
|---|---|
| `desktop-provider-sour-chart-caption-placed.png` | The clinician's brief on the seeded week: the chart caption and the Spikes-linked-to-places card under it, where the per-row relation the prompt now describes is what the Place column prints. The narrative above it is the §6.3 degraded state, which is why there is no pattern to read. |
| `mobile-provider-sour-chart-caption-placed.png` | The same card at 375px (§6.5). |
| `desktop-provider-print.png` | The printed one-pager (§7.4), the second clinician surface the same rows reach — and the frame that shows why there is no picture of this ticket's subject: "Assistant not configured: the numbers are complete; patterns and questions were not generated", with Patterns and Ask-the-patient both reading "Not generated." That banner is `degradedPair`, and it is what every screen in this run shows where the model's words would be. |
