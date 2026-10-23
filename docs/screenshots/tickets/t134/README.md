# T134 — the demo button promised a connection the summary had just stopped promising

**There is no frame of the state this ticket fixes**, and the ticket's definition of done says so rather
than asking for a deployment to be arranged for a picture. `scripts/agent-check.sh` sets no Dexcom
credentials — the mode the whole product is built to work in (§6.3, §11.3) — so `dexcomConnectControl`
returns `"none"` for every visit the suite books and `DexcomDemoLink` is not rendered anywhere in it.
`docs/screenshots/tickets/t125/README.md` records the same thing for the state it could not shoot, and
`t118`'s does for its own; this is the third surface of one promise and the last one still out of reach.

The three PNGs here are the states this ticket **preserves**, and they are exactly where
`e2e/dexcom.spec.ts` now asserts the two labels are absent. They are from the
`bash scripts/agent-check.sh` run that passed (exit 0; 1017 unit tests with 1 skipped, 19 infra, 264
Playwright with 10 skipped) on the tree these commits landed as.

| File | What it shows |
|---|---|
| `desktop-dexcom-unconfigured-connect.png` | The intake step's data panel with no credentials: the Dexcom card offers **Upload CSV** and nothing else, and the lede says "Upload your Dexcom export." This is the slot the compact label sits in when a deployment has credentials on the sandbox — the tight account row beside the card's heading, which is why that label is the shorter of the two. Nothing on the panel is a dead control (T91) and the hint names no operator fact (T71). |
| `desktop-dexcom-production-connect.png` | The same screen on the production deployment, where this visit's own readings *are* on offer: **Connect Dexcom**, over "Authorize on Dexcom and return here. Your last 7 days of readings are imported." That is the claim this ticket took out of the demo button — here it is true, and here it is untouched. |
| `desktop-sweetie-start.png` | The Sweetie page with no credentials, where the full-length label's amber card goes. The card is not rendered, because `POST /api/dexcom/demo` answers 503 without credentials (T91), and the page closes up behind it. |

## What a patient would have read, before and after

A real (non-synthetic) patient on §13.4's sandbox deployment, who has just pressed **Try the Dexcom
demo** on their own summary (§2.7, T125):

| Where | before | after |
|---|---|---|
| `/s/<token>` — the amber card | **Try Dexcom sandbox** | **Try the Dexcom demo** |
| `/s/<token>/intake` — the Dexcom card's account row | **Connect Dexcom · Demo** | **Dexcom demo** |

The first named which Dexcom an operator pointed this deployment at, which no patient is ever told (the
T71 rule). The second made the one claim this state has none of — no readings of the patient's own are
coming — one click after the invitation had carefully avoided making it. The card's own sentence
("Explore with synthetic glucose readings in a separate demo session. Your patient record and uploads
will not change.") was already right and is unchanged.

Both labels are now built from one subject in `lib/dexcomHint.ts`, beside `DEMO_SESSION` and
`DEMO_UNCHANGED` for the same reason: `DEMO_SUBJECT` is "Dexcom demo", `DEMO_ACTION` is
`Try the ${DEMO_SUBJECT}`, and `summaryDataInvite`'s `"demo"` action *is* `DEMO_ACTION`. The invitation
and its destination cannot be reworded apart.

## What stands in for the picture

- **`lib/dexcomHint.test.ts` → `the demo link's own button keeps the invitation's promise (T134)`** —
  pins `DEXCOM_DEMO_LABEL` as an equality, asserts `full === summaryDataInvite({ control: "demo" }).action`
  and that `compact` is that action's subject, and holds both to the two rules: no "sandbox", no
  `OPERATOR`, no "Connect Dexcom". It also pins the other side of the T71 rule — `OPERATOR` does not gain
  "sandbox", and `says("oauth", true)`, the synthetic demo patient's own copy, keeps the word, because
  there it describes the account that patient *is* rather than an operator's choice.
- **`lib/dexcomHint.test.ts` → `each control gets its own invitation … (T125)`** — unchanged, and still
  pins all six rows of the invitation as equalities, so the phrase the labels are built from cannot move
  without this failing too.
- **`e2e/dexcom.spec.ts`** — the three absences it asserts on the frames above now read
  `DEXCOM_DEMO_LABEL.full` and `.compact` instead of the two literals. Before, a reword would have left
  them true of a string nothing renders.

## Out of scope, and unchanged

`app/s/[token]/page.tsx:548`'s "Connect Dexcom sandbox — only the dedicated demo patient is permitted."
is behind `sandboxPatient === true`, so it is shown to the synthetic demonstration patient only; the
ticket says to say so rather than change it. The OAuth button on the intake step
(`app/s/[token]/intake/page.tsx:638`, "Connect Dexcom · Demo" / "Reconnect Dexcom · Demo") is reached
through `connectControl === "oauth"`, which on a sandbox deployment is that same patient — a different
component and a different reader.
