# How the build and review routines work

Two scheduled cloud agents advance this repo toward `docs/PRODUCTION_DESIGN.md`. They never talk to each other;
they coordinate through GitHub issues, labels, and pull requests. Humans can do everything they do.

## Ticket stack

Issues titled `T<nn>: ...`, numbered in dependency order. State lives in labels:

| Label | Meaning |
|---|---|
| `ready` | Unblocked, nobody has started it |
| `in-progress` | A builder run has claimed it (branch pushed) |
| `review` | A pull request is open and waiting for the reviewer |
| `changes-requested` | The reviewer sent it back with comments |
| `blocked` | Waiting on a human (credentials, an account, a decision) |

A merged pull request closes the issue. Bugs the reviewer finds become new issues labeled `ready` and `bug`.

## The builder

Runs every two hours. One ticket per run.

1. `git fetch`, check out `main`.
2. Pick the ticket: the lowest-numbered issue labeled `changes-requested` whose branch exists; otherwise the lowest-numbered `ready`. Skip anything `blocked`. If none, stop.
3. Label it `in-progress`. Branch `t<nn>-<slug>` from `main` (or continue the existing branch).
4. Read the cited design sections and the acceptance criteria. Implement the whole ticket. Small, focused commits.
5. Run `scripts/agent-check.sh`. Fix what fails. Look at the screenshots in `e2e/screenshots/` and confirm the affected screens look right. Copy the relevant ones to `docs/screenshots/tickets/t<nn>/` and commit them.
6. Open or update the pull request: title `T<nn>: ...`, body with what changed, the design sections, how it was verified, and the screenshots. Label the issue `review`, remove `in-progress`.
7. If the ticket cannot be finished (missing credential, unclear design), write what is missing in a comment, label `blocked`, and stop.

## The reviewer

Runs every three hours. Reviews every open pull request labeled `review`, oldest first.

1. Check out the branch. Run `scripts/agent-check.sh`. Look at the screenshots.
2. Compare the result with the cited design sections and the acceptance criteria, line by line.
3. Small problems (naming, a missing edge case, a lint warning, a wrong label): fix them on the branch, commit, note it in the review.
4. If it matches: approve, squash-merge, delete the branch. The issue closes.
5. If it does not: request changes with a precise list, label the issue `changes-requested`, remove `review`.
6. Then sweep: run the full check on `main`, open the app, click through the two flows. Anything broken or drifting from the design becomes a new issue labeled `ready` and `bug`, with steps to reproduce, placed before the next feature ticket in numbering if it blocks it.

## Running and viewing the app

`scripts/agent-check.sh` installs dependencies, prepares a throwaway database, seeds demo data, runs typecheck, lint,
unit tests, and the Playwright suite, and writes screenshots to `e2e/screenshots/`. Both agents read those PNGs to
see what they built. `npm run e2e:ui` is for humans.

## Rules both follow

- Never push to `main` directly. Never force-push a shared branch.
- Never commit secrets, `.env`, or real patient data. Fixtures are synthetic.
- Keep the contract in `lib/types.ts` and the agent architecture in `docs/AGENT_ARCHITECTURE.md` unless the ticket says otherwise.
- When in doubt, leave a comment on the issue and move on rather than guess.
