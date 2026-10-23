# T125 — the patient summary offered Connect Dexcom where only the demo link waited

**There is no frame of the state this ticket fixes**, and the ticket's fifth acceptance criterion says
so rather than asking for a deployment to be arranged for a picture. The two PNGs here are the state it
**preserves** — the `"none"` invitation, which is what the check script's deployment renders and what
acceptance criterion three holds to a `deepEqual`. They are from the `bash scripts/agent-check.sh` run
that passed (exit 0; 967 unit tests, 250 Playwright, 10 skipped) on the tree these commits landed as.

| File | What it shows |
|---|---|
| `desktop-a11y-summary-empty.png` | §2.7's empty state with no credentials: "Share your Dexcom export in Sweetie and it will turn your readings into a clear picture for you and your doctor." under **Upload your Dexcom export**. Both are word for word what T118 left; this ticket changed neither. The T123 eyebrow still reads YOUR CHECK-IN WITH SWEETIE, naming no span. |
| `mobile-375-patient-summary-empty.png` | The same at 375px (§6.5), where the card is the whole ask below the hero. The button sets on one line, the sentence wraps to two, and `expectMobileReady` asserts no horizontal scroll. |

## Why the state that changed has no frame

The invitation `summaryDataInvite` returns is chosen by `dexcomConnectControl`, and the branch this ticket
split off is `"demo"`:

| `control` | Reached when | In the check script |
|---|---|---|
| `"oauth"` | credentials, and this visit may connect to the Dexcom the deployment talks to | no |
| `"demo"` | credentials, `DEXCOM_ENV=sandbox`, and an ordinary (non-synthetic) patient | **no** |
| `"none"` | no credentials — the README's deployment, the demo's, and this one | yes |

`scripts/agent-check.sh` sets no Dexcom credentials, which is the mode the whole product is built to work
in (§6.3, §11.3). `dexcomConnectControl` returns `"none"` for every visit the suite books, whatever else
is true of it, because the sandbox needs the same client production does. So **both** credentialled
states are out of the suite's reach, not just this one, and the two frames above are the only frames of
this screen there are to take. `docs/screenshots/tickets/t118/README.md` records the same thing for the
state it could not shoot.

## What stands in for the picture

`lib/dexcomHint.test.ts`, which drives `summaryDataInvite` directly and so covers every state including
the unreachable ones:

- **`each control gets its own invitation, for both kinds of patient, as equalities (T125)`** — all three
  controls x `sandboxPatient`, six rows, each an equality. `"oauth"` and `"none"` are pinned to the four
  strings T118 left; `"demo"` is pinned to the new pair. The collapse itself is an assertion:
  `says("demo", false)` is not `says("oauth", false)`. Folding the branch back onto `control !== "none"`
  fails this test and three others.
- **`the demo invitation makes the destination's promise, not one about the patient's own data (T125)`** —
  the invitation and the destination's own hint are checked to carry the same two phrases, which are one
  constant each in `lib/dexcomHint.ts` rather than two literals that can be reworded apart.
- **`the new state is held to the same two rules as every other (T71's and T123's)`** — no operator fact
  in patient copy, no span named, over the same six rows.

## What a reader would have seen, before and after

For a real patient on the sandbox deployment, on `/patient/<token>` with nothing shared:

| | Sentence | Button |
|---|---|---|
| before | "Connect your Dexcom export and Sweetie will turn your readings into a clear picture for you and your doctor." | **Connect Dexcom** |
| after | "The Dexcom demo in Sweetie opens a separate synthetic-data session — synthetic readings, not your own. Your existing uploads stay unchanged." | **Try the Dexcom demo** |

The button still leads to `/s/<token>`, where `DexcomDemoLink` is the only Dexcom control for this state —
a link to a separate synthetic session, exactly as the sentence now says.
