# T125 — the patient summary offered Connect Dexcom where only the demo link waited

**No PNGs in this directory, deliberately.** The state this ticket fixes is the one the suite cannot
reach, and the ticket's fifth acceptance criterion says so rather than asking for a deployment to be
arranged for a picture.

## Why there is no frame of it

The invitation `summaryDataInvite` returns is chosen by `dexcomConnectControl`, and the branch this ticket
split off is `"demo"`:

| `control` | Reached when | In the check script |
|---|---|---|
| `"oauth"` | credentials, and this visit may connect to the Dexcom the deployment talks to | no |
| `"demo"` | credentials, `DEXCOM_ENV=sandbox`, and an ordinary (non-synthetic) patient | **no** |
| `"none"` | no credentials — the README's deployment, the demo's, and this one | yes |

`scripts/agent-check.sh` sets no Dexcom credentials, which is the mode the whole product is built to work
in (§6.3, §11.3). `dexcomConnectControl` returns `"none"` for every visit the suite books, whatever else
is true of it, because the sandbox needs the same client production does. So both credentialled states are
out of the suite's reach, not just this one: `docs/screenshots/tickets/t118/README.md` records the same
thing for the state it could not shoot, and the frames it *does* hold
(`desktop-a11y-summary-empty.png`, `mobile-375-patient-summary-empty.png`) are the `"none"` state, which
this ticket returns word for word — asserted as a `deepEqual`, not a match.

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
