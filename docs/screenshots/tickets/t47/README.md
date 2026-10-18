# T47 — ci on main after an auto-merge

T47 changes no screen. The deliverable is `.github/workflows/ci.yml`, `.github/workflows/auto-merge.yml` and
the section of `docs/ROUTINES.md` that explains them, so the evidence is in three parts: what `main` looks
like without the fix, what the workflows now do, and the screens unchanged — which is what a ticket about CI
should do to the app.

## What `main` looks like without it

`ci` has run on `main` **12 times in the life of the repository, and not once since 2026-10-14T05:14Z**:

```bash
gh api "repos/$R/actions/workflows/ci.yml/runs?branch=main&per_page=100" \
  --jq '.workflow_runs[] | "\(.head_sha[0:7]) \(.event) \(.conclusion) \(.created_at)"' | head -3
# 06cb271 push success 2026-10-14T05:14:03Z   <- the last one
# 4492f85 push success 2026-10-14T05:07:23Z   <- auto-merge arrived in this commit
# df75da7 push success 2026-10-11T15:48:40Z
git log --oneline 06cb271..origin/main | wc -l
# 35
```

Thirty-five commits, every one of them a squash merge `auto-merge` performed, none of them checked. The issue
counted three; the gap has been widening for two days. Each was green on its own branch, which is not the
same claim as §12.4's: T46 is the one where the combination broke `next build` and `main` stayed red until a
reviewer ran `scripts/agent-check.sh` by hand.

## What the workflows do now

| trigger | starts a run on | why |
|---|---|---|
| `pull_request` | the branch | unchanged — the pre-merge check `auto-merge` waits for |
| `push` to `main` | the commit | unchanged — a human landing a commit |
| `workflow_dispatch` | `main` | **new.** `auto-merge` calls `createWorkflowDispatch` once it has merged. A push made with the repository's `GITHUB_TOKEN` starts no workflow run; an API dispatch does |
| `schedule`, hourly | `main` | **new.** The backstop. `sweep` asks whether `main`'s tip already has a `ci` run and stops there when it does |

And the verdict reports itself: the `main-state` job opens one issue labeled `main-red`, `bug` and
`area:quality` while `main` is failing, comments on it once per further commit, and closes it on the first
green run. No `T<nn>` number and no `ready` label — a red `main` is a diagnosis for the reviewer sweep, not a
ticket the builder should pick up blind.

`lib/workflows.test.ts` (3 tests) asserts the wiring, because nothing else would: when it is dropped, runs
stop happening rather than going red.

## What could not be verified before the merge

`createWorkflowDispatch` needs the `workflow_dispatch` trigger to exist on the **default branch**, and on
`main` it does not exist yet. So the dispatch itself is demonstrable only on this pull request's own merge,
which is the demonstration the issue asks for: after `auto-merge` squash-merges this, a `ci` run appears on
`main` with `event: workflow_dispatch`. The pull request body carries the command to check it.

## The screens, unchanged

From the `bash scripts/agent-check.sh` run this pull request reports (exit 0; 655 unit tests passed, 1
skipped, 93.04% statements; 19 infra tests; 178 Playwright tests passed, 6 skipped).

| File | What it shows |
|---|---|
| `desktop-landing.png` | the landing page, both agents |
| `desktop-provider-dashboard.png` | the practice dashboard after sign-in, 17 visits |
| `desktop-provider-sour.png` | the Sour brief for the seeded visit |
| `desktop-sweetie-start.png` | Sweetie's first question on the patient link |
| `mobile-patient-summary.png` | the patient summary at 375px |

Three things visible in them are open bugs owned by other tickets, not regressions here: the raw `follow_up`
pill on the patient summary (T41, in review), "LLM not configured: set OPENAI_API_KEY" in the brief's
patterns (T63), and the hero pill over the Sweetie and Sour captions on the landing page (T52).
