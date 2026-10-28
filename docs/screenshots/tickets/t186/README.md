# T186 — the brief's sidebar named a clinician with no name "…", the same glyph it shows while loading

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where no email or
SMS backend is configured — the environment the bug was reported in, and the one a fresh `.env` is in.

All three frames are the §2.6 brief at the desktop project's 1280 × 720, `SCREENFUL`, so the sidebar sits
where a clinician meets it: top left, over the patient this brief is for.

| File | What it shows |
|---|---|
| `desktop-provider-sour-sidebar-no-name.png` | **The ticket.** Under **PRACTICE**, the heading now reads **"No name set"** over *Example Endo*. Before this ticket it read `…` — not for a moment, but for ever, because `provider?.name ?? "…"` answered both "the fetch has not come back" and "this account has no name on it" with one glyph, and only the first of those ever resolves. §2.1 leaves every practice's first admin nameless until somebody types one into settings, and every colleague an admin invites by email with none at all, so this was the ordinary state of the page's `<h1>`. |
| `desktop-provider-sour-sidebar-named.png` | **The half that keeps it honest.** The seeded provider, two lines unchanged word for word: *Dr. Demo Endo* over *Sweet Spot Endocrinology*. Read it against `docs/screenshots/tickets/t185/desktop-provider-sour-ready.png`, whose sidebar is the same block before this ticket. A rule met by saying less to everybody would have changed this frame; it does not. Both frames come from one test (`e2e/briefSidebar.spec.ts`) for that reason. |
| `desktop-sour-invite-no-handover.png` | **The frame the bug was found in.** The reviewer sweep read this picture, saw *Example Endo* already painted under an ellipsis, and knew the glyph was a final state rather than a flicker. It is the same shot from `e2e/invite.spec.ts`, which now asserts the heading where it is taken, and it reads **"No name set"**. |

## Why there is no 375px frame

`.sour-practice` is `display: none` under the phone breakpoint (`app/globals.css:5715`). That is a decision
about the §6.5 layout — the phone gets the brief, not the practice sidebar — and widening a deliberate
breakpoint to take a screenshot is not a fix, which is the answer T181 reached for the §2.2 import dialog.
So `e2e/briefSidebar.spec.ts` skips on the mobile project and says so in the skip reason, and there is no
`mobile-…` file here.

## The wording, and the one thing a reviewer should weigh

`signedInHeading` (`lib/team.ts`) takes `memberSubLine`'s own answer rather than inventing a fourth sentence
for one fact: the practice settings users table one screen over already tells this practice what an account
with no name on it is, and criterion 4 asks for one missing name and one wording. `NO_NAME_SET` rather than
`NO_NAME_IN_INVITE` with nothing to ask, because whoever is reading a brief redeemed a link to get here and
is therefore not pending (§5.1).

Not the printed sheet's `NO_CLINICIAN` ("No clinician recorded", `lib/visit.ts`), for two reasons. It is a
claim about *whose visit this is* rather than about the account doing the reading, and §2.2 never asks the
wizard for a clinician — the person reading a brief may well be the receptionist, which is the distinction
the dashboard's own greeting is written around (`app/provider/dashboard.tsx:426`). And it lives in a module
that imports Prisma, where a client component cannot follow it without pulling the database client into the
browser bundle.

**Worth a reviewer's eye:** under an eyebrow that reads **PRACTICE**, "No name set" sits directly over the
practice's name, and a reader skimming the block could take the sentence for a claim about the practice
rather than about themselves. The frames above are the evidence either way. It was left as it is because
every alternative costs more than it buys: a sentence naming the person ("This account has no name") is a
fourth wording for the one fact criterion 4 asks to have one of, and rewording the eyebrow would change the
named account's block, which criterion 3 pins word for word.
