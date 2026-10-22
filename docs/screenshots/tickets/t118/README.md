# T118 — the patient's summary offered Connect Dexcom where the deployment has no Dexcom

From the `bash scripts/agent-check.sh` run that passed (exit 0, 228 Playwright tests, 10 skipped) on the
tree these commits landed as. The check script sets no Dexcom credentials, so both frames below *are* the
unconfigured deployment — the default local mode and the mode the demo runs in — and not a state arranged
for the picture.

What to check in them is the button. Before this ticket it read **Connect Dexcom** and led to `/s/<token>`,
where T91 had already resolved the Dexcom control to `"none"`: no OAuth button, no demo link, only the three
file uploads. The button was not dead, which is what made it worth a ticket of its own — it was a promise
the destination could not keep.

| File | What it shows |
|---|---|
| `desktop-a11y-summary-empty.png` | §2.7's empty state with no credentials. The button now reads **Upload your Dexcom export**, which is what `/s/<token>` can actually take, and the sentence above it "Share your Dexcom export in Sweetie and it will turn your readings into a clear picture for you and your doctor." Neither says why there is no connection: "not configured" and "demo mode" stay out of patient copy, the T71 rule. The card, the arrow tile and the heading are untouched. |
| `mobile-375-patient-summary-empty.png` | The same at 375px (§6.5), where this is the only control on the screen below the hero and so carries the whole ask. The button sets on one line inside the card and the sentence wraps to two; `expectMobileReady` asserts no horizontal scroll. |

Both shots are the `-empty` frame only. The state with readings in it is not pictured because the change
cannot reach it: the branch edited is the `!bundle.status.hasDexcom` one, and where credentials exist
`summaryDataInvite` returns the two strings that were there before, word for word, the `isSandbox` branch
included — `lib/dexcomHint.test.ts` asserts them as equalities rather than matches for exactly that reason.

The third state has no screenshot because the suite cannot reach it: a synthetic demonstration visit
(§13.4) whose credentials have gone gets a card with no button at all, since `/s/<token>` renders its
uploads for a real visit only and there is no second path to name. `POST /api/dexcom/demo` refuses without
credentials, so such a visit can only exist where the keys were removed after it was made. It is covered in
`lib/dexcomHint.test.ts` instead.

The "past week" in the connected branch's sentence is deliberately untouched — T114 (#185) named that
wording as out of its scope and this ticket says the judgement stands.
