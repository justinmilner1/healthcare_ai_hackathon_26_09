# T115 — a signed-in admin was told their name would be added when they first signed in

From the `bash scripts/agent-check.sh` run that passed on the tree these commits landed as. The pair to read
first is `*-provider-settings-users` at either width: one table holding three of the four states the sub line
has to tell apart.

| File | What it shows |
|---|---|
| `desktop-provider-settings-users.png` | §2.1's users table at 1280px, with the three rows the ticket is about on screen at once. Row one, `jennifer.rodriguez+…@northstar-roles.com (you)`: the green **Signed in** pill, and under the heading **"No name set"** where it used to read "Adds their name when they first sign in" — the promise the pill beside it had already falsified. Row two, the colleague invited with no name: **Invited**, and **"No name in the invite"**, a different fact and so a different sentence. Row three, `Dr. Maya Chen`, invited *with* a name: unchanged by this ticket — the name is the heading and the address is the sub line. |
| `mobile-provider-settings-users.png` | The same three rows at 375px, where the table is stacked cards (§6.5). The sub lines sit under their headings at a readable size and none of them wraps past the card. |
| `desktop-provider-settings-you-named.png` | The fourth state, and the other half of the ticket: the admin has typed their name into the new **You** card and pressed Save. Row one now reads `Dr. Jennifer Rodriguez (you)` over the address, still **Signed in** — and nothing was reloaded to get there, because PATCH `/api/practice/me` returns the caller's own member row and the screen swaps it into the team it already has. The card above shows the saved value and its "Saved." notice. |
| `mobile-provider-settings-you-named.png` | The same at 375px. |
| `desktop-journey-01-practice-users.png` | The frame the ticket was filed against (§12.2's journey, a different practice). Before: the admin's row carried the false sentence and `Dr. Journey Okafor`'s did not, so the contradiction was visible in the contrast between them. Now all three rows report state: "No name set" for the signed-in admin, the address for Dr. Okafor, "No name in the invite" for the front desk. The **You** card is in this shot too, under "The practice". |
| `mobile-journey-01-practice-users.png` | The same journey table at 375px. |

The **You** card is half the width of the grid's second row on a desktop and a full-width card at 375px; the
whole page at both widths is `*-provider-settings.png` in `e2e/screenshots/` from the same run.

Why a card and not only a reworded sentence: §4.2 gives `User` a name, and before this the only writer of it
was the invite form's optional field — which the person who signs a practice up never passes through, because
they create their own account. Rewording alone would have left that person's name permanently unreachable.
