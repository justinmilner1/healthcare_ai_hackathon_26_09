# How the build and review routines work

Two scheduled cloud agents advance this repo toward `docs/PRODUCTION_DESIGN.md`. They never talk to each other;
they coordinate through GitHub issues and labels, and both commit straight to `main`. Humans can do everything
they do.

Until 2026-10-18 every ticket went up as a pull request that the reviewer labeled `merge-ready` and a GitHub
Actions workflow merged. That ended when Actions stopped running on the account (billing, T75) and twenty
reviewed pull requests sat unmerged for two days. The gate was never Actions anyway: it is
`scripts/agent-check.sh`, which both routines run in their own sandbox on the exact tree they push. So now the
builder pushes to `main` once that check passes, and the reviewer reviews what landed. Pull requests, the
`merge-ready` label and `.github/workflows/auto-merge.yml` are gone; `ci.yml` still runs on `main` when
Actions is available, as a second opinion, not as the gate.

## Ticket stack

Issues titled `T<nn>: ...`, numbered in dependency order. State lives in labels:

| Label | Meaning |
|---|---|
| `ready` | Unblocked, nobody has started it |
| `in-progress` | A builder run has claimed it |
| `review` | The builder has landed it on `main` and it is waiting for the reviewer |
| `changes-requested` | The reviewer found gaps; the builder fixes forward on `main` |
| `blocked` | Waiting on a human (credentials, an account, a decision) |
| `main-red` | Not a ticket: `ci` is failing on `main` right now. Opened and closed by `ci.yml` itself (T47). `main-state` is an Actions job that needs a verdict from `check`, so a run that cannot produce one — no runner (T92), or killed at its budget (T215) — cannot raise the label either, and its absence is not a green signal. "The state of `main`" below is the whole list |

The reviewer closes the issue once what landed meets the ticket. Bugs the reviewer finds become new issues labeled
`ready` and `bug`.

### Where a new ticket's number comes from

**The highest `T<nn>` across every issue *and* pull request, in *any* state, plus one.**
`scripts/gh-issues.sh next-number` is that rule as a command; it is
[below](#github-from-the-sandbox-rest-only), next to the other REST calls. Take the number from it rather
than from a page walk of your own: a walk that loses a page answers with a number already taken, and that is
the third trap in that section.

Nothing narrower is safe. Both routines once took the number from the open issue list, which misses every
closed ticket — and most of the stack is closed. Three items landed in one afternoon on numbers already
taken: #64 and #66, plus #66's pull request #67, which inherited the number from it. A duplicate number makes
`Depends on: T<nn>` ambiguous, and that is the one piece of state the whole stack rests on. Pull requests count
towards the maximum because a pull request inherits its ticket's title, so a number is spoken for as soon as
either one exists.

Two routines on different schedules can still race between the read and the write. When the number you filed
under turns out to be taken:

- **Retitle your own issue** to the next free number, recompute it with the snippet first, and leave a comment
  on it saying which number it moved from and which ticket it collided with.
- **Never retitle someone else's.** Whichever was filed first keeps the number, and GitHub hands out issue
  numbers in order, so that is simply the lower `#`.
- Fix the branch and pull request names too if you have already pushed; if the pull request is merged, leave it
  and add a row to the table below instead.

### Numbers that name two tickets

Two collisions predate the rule and are now permanent — their duplicates are closed and their pull requests are
merged, so the titles in the history cannot be corrected. `Depends on: T42` and `Depends on: T45` mean the
tickets in the middle column, #55 and #60:

| Number | The ticket that owns it | Also titled this in the history |
|---|---|---|
| `T42` | #55 — "Unit tests for the `lib/` modules §12.1 still leaves untested" | #66 and its pull request #67 — the `node:crypto` edge-bundle build break (closed, merged) |
| `T45` | #60 — "Clear `.next` at the start of every check run" | #64 and its pull request #69 — `lib/log.ts` reaching the edge bundle (closed, merged) |

This matters for more than tidiness: the duplicate in the right-hand column is closed either way, so resolving
one of these two dependencies by title alone can answer "closed" for a number whose owning ticket is not done,
and a ticket gets built on a dependency that was never finished. Resolve a `Depends on:` with the dependency
snippet below, which excludes pull requests, and read this table when it returns more than one row.

## The builder

Runs every two hours. One ticket per run. Works on `main`, pushes only a tree the check has passed on.

1. Deepen, check out `main`, fast-forward: `git fetch --unshallow origin || git fetch origin`, then
   `git checkout main`, then `git pull --ff-only`. Never a bare `git pull`: this container's checkout is
   shallow, and on a shallow checkout a bare pull reports a divergence that is not there
   ("A shallow checkout, and the divergence that is not one" below).
2. Pick the ticket: the lowest-numbered issue labeled `changes-requested`; otherwise the lowest-numbered `ready`. Both listings go through `scripts/gh-issues.sh list` ("GitHub from the sandbox" below): a bare `gh api` answers this one with an empty array often enough that "If none, stop" would end a run with six tickets open, and nothing in the log would say why. Skip anything `blocked`. Resolve each of its `Depends on: T<nn>` lines with `scripts/gh-issues.sh depends T<nn>` and require that ticket closed — it excludes pull requests, and two numbers name two tickets apiece, so check that table when it returns more than one row. If none, stop.
3. Label it `in-progress`, remove `ready` or `changes-requested`, and comment `Builder run started <UTC time>` on the issue. If a previous run left a `t<nn>-wip` branch on origin, `git merge origin/t<nn>-wip` into `main` locally and continue from there.
4. Read the cited design sections and the acceptance criteria. Implement the whole ticket on `main`, locally. Small, focused commits, every message starting `T<nn>:` — that prefix is how the reviewer finds the ticket's commits.
5. Run `scripts/agent-check.sh`. Fix what fails — but read what the script says about the failure first: a stage several times its usual length and no failed assertion is a slow box, not a red tree, and on a failed suite the serial re-run of just those tests says which of the two it was ("When the box is the problem" below). Look at the screenshots in `e2e/screenshots/` — the script empties it first, so everything in it is from this run — and confirm the affected screens look right. Copy the relevant ones to `docs/screenshots/tickets/t<nn>/` and commit them.
6. Land it: `git pull --rebase origin main`. If that brought in anything, run the check again on the rebased tree. Then `git push origin main`. If the push is rejected because `main` moved again, rebase, re-check, push. Never force-push.
7. Comment on the issue with the commit range (`<first sha>..<last sha>` on `main`), what changed, the design sections fulfilled, the exact verification commands and their results, and the paths of the committed screenshots. Label the issue `review`, remove `in-progress`. Delete the `t<nn>-wip` branch if there was one (`git push origin --delete t<nn>-wip`; if the proxy refuses, leave it and say so in the comment).
8. If the ticket cannot be finished (missing credential, unclear design) or the run is out of time: do not push unfinished work to `main`. Push it to a branch `t<nn>-wip`, comment on the issue with what is done and what remains, and leave `in-progress` (out of time) or label `blocked` (needs a human), removing `in-progress`.

## The reviewer

Runs every three hours. Reviews the tickets labeled `review`, lowest number first, up to three per run, then sweeps `main`.

1. Deepen, check out `main`, fast-forward — `git fetch --unshallow origin || git fetch origin`,
   `git checkout main`, `git pull --ff-only`, never a bare `git pull`
   ("A shallow checkout, and the divergence that is not one" below); the full history is also what step 2
   and step 5 need to read a ticket's commits at all. List the tickets labeled `review` with
   `scripts/gh-issues.sh list` ("GitHub from the sandbox" below), never a bare `gh api`: an empty answer
   there is a run that reviews nothing and goes straight to the sweep, which is exactly what happened on
   2026-10-22. Run `scripts/agent-check.sh` once, on `main` as it is now; every review below reads that result and those screenshots. The run starts from an empty `e2e/screenshots/`, so the PNGs are this tree's and no earlier run's.
2. For each ticket: find its commits — the builder's comment names the range, and `git log --oneline origin/main --grep='^T<nn>'` finds them by the message prefix. Read the diff (`git log -p <first>^..<last>`), the issue body, and the design sections it cites. Compare the result with the acceptance criteria, line by line; read the code, not just the comment.
3. Small problems (naming, a missing edge case, a lint warning, a missing test): fix them on `main`, commit with a message starting `Review T<nn>:`, run the check, `git pull --rebase origin main`, push. Note each fix in your comment.
4. If it matches: comment on the issue naming the design sections it fulfills, the commits you read, and what you checked, then close the issue and remove `review`.
5. If it does not: comment with a precise numbered list, each item naming the criterion or design section and exactly what is missing or wrong, with file paths. Label the issue `changes-requested`, remove `review`. The builder fixes forward on `main`; nothing is reverted for a gap. Revert (`git revert`, then the check, then push) only when a commit has broken the check on `main` and the fix is not obvious — a check that ran out of time on a slow box has broken nothing, so read the timings table *and* the serial re-run's verdict before you revert, since a single blown wait is in the second and not in the first — then say which commit and why in the comment.
6. Then sweep: read the state of `main` below — a `main-red` issue, when Actions is running, says what broke before you run anything. Open the app, click through the two flows. Anything broken or drifting from the design becomes a new issue labeled `ready` and `bug`, with steps to reproduce, placed before the next feature ticket in numbering if it blocks it. Take its `T<nn>` from `scripts/gh-issues.sh next-number`, which is the rule above — the highest across every issue and pull request, any state, plus one — and run it again for each issue you file in the same sweep, so two bugs in one run do not land on one number.

## The state of `main`

The gate is the check both routines run in the sandbox on the tree they are about to push. `main` therefore
should never be red; when it is — when `scripts/agent-check.sh` fails an assertion on `main` as it stands —
that is the top priority for whichever routine notices: fix it on `main` if the cause is obvious and small
(commit `Fix main: ...`, check, push), otherwise revert the commit that broke it and file the bug.

A check that *ran out of time* rather than failing an assertion has not shown `main` to be anything. Read the
timings table before you act on a failure: "When the box is the problem" below says how to tell the two apart
and what to do, and reverting on that evidence removes work that was never broken.

`.github/workflows/ci.yml` runs the same check on GitHub's runners on every push to `main`, hourly as a
backstop, and on any pull request a human opens. It is a second opinion: a different machine, a fresh
checkout, a Postgres in a service container. Its `main-state` job opens one issue labeled `main-red`, `bug`
and `area:quality` when the check fails on `main`, comments on it once per further commit, and closes it on
the first green run. That issue has no `T<nn>` number and no `ready` label — it is for the reviewer sweep to
read, diagnose and file as a numbered ticket, not for the builder to pick up blind.

### What a `ci` run is evidence about (T75, T92, T215)

**Actions runs again.** It was blocked for most of October (T75) and started running again between
`2026-10-31T23:12Z` and `2026-11-01T00:52Z`. This section used to say flatly that Actions "cannot run" and
told both routines to recognise a blocked account by `steps=0` and a sub-five-second duration. That signature
is **history**: it is what a run from before 2026-11-01 looks like, and runs since do not look like it at all.
Keep reading it as one entry in a list rather than as the state of the world — getting this wrong costs a
routine a revert of healthy work, which is why the list exists.

The one call that lists the runs:

```bash
# the ci runs on main, newest first: run id, sha, what triggered it, verdict
gh api "repos/$R/actions/workflows/ci.yml/runs?branch=main&per_page=10" \
  --jq '.workflow_runs[] | "\(.id) \(.head_sha[0:7]) \(.event) \(.status)/\(.conclusion // "pending") \(.created_at)"'
# 41328771421 9d25f75 push     completed/cancelled 2026-11-01T16:55:15Z
# 41325619942 8442476 schedule completed/success   2026-11-01T16:18:07Z
# 41318526276 8442476 push     completed/cancelled 2026-11-01T14:54:53Z
# 41251575388 82ad63b push     completed/failure   2026-10-31T23:12:57Z   <- the blocked account, before
```

**A run-level conclusion is never the answer.** Readings below share a `conclusion` with each other, and not
one of the four runs above is a verdict on a tree: two were killed at a budget, one is the blocked account,
and the green one is the hourly backstop finding nothing to do. So the question is always the same one, and it
takes one more call on a run id the snippet prints: **what did this run actually execute?**

```bash
# what ran, and for how long: the conclusion field cannot answer this
gh api "repos/$R/actions/runs/41328771421/jobs" \
  --jq '.jobs[] | "\(.name) \(.conclusion) steps=\(.steps|length) \(.started_at) \(.completed_at)"'
# check      cancelled steps=10 2026-11-01T16:55:18Z 2026-11-01T17:15:42Z   <- a real runner, killed at its budget
# sweep      skipped   steps=0  2026-11-01T16:55:16Z 2026-11-01T16:55:16Z
# main-state skipped   steps=0  2026-11-01T17:15:42Z 2026-11-01T17:15:42Z
```

Five readings, and **only the last is a red tree**:

- **`cancelled`, steps recorded, the `check` step ending on the job's `timeout-minutes`** — the job ran out of
  its budget part-way through. It executed a real checkout and a real suite and may have passed hundreds of
  tests, but it was killed before the check could exit, so **there is no verdict in it at all**. Like a
  blocked run, and like the slow box of "When the box is the problem" below, it is
  **never** grounds for a revert — not under the reviewer's step 5 and not under the "fix it on `main` first"
  rule at the top of this section: a clock that ran out has not seen the product answer wrongly. This is what
  every push run between `2026-11-01T00:52Z` and T215 was, cancelled at 20m24s against a
  `timeout-minutes: 20` that a roughly 28-minute check never fitted. If it recurs, the budget is the bug and
  `.github/workflows/ci.yml` says what the current one was sized against — not a test to skip or a budget to
  lower (T215, acceptance criterion 6).
- **`failure`, `steps=0`, started and completed within about five seconds** — the blocked account of T75 and
  T92. The run was created and allocated no runner, so it checked out nothing, installed nothing, built
  nothing and asserted nothing, and it says nothing about any commit it names. History since 2026-11-01, and
  kept here because the runs from October still read this way and because billing can lapse again.
- **`success` whose `check` is `skipped`, on a `schedule` run** — the hourly backstop finding nothing new.
  `sweep` asks whether main's tip already has a run of its own and short-circuits when it does, so the run
  costs a few seconds and the green tick is `sweep`'s, not the check's (run 41325619942: `sweep success
  steps=3`, `check skipped steps=0`). **Not evidence that anything passed.** The verdict on that commit, if
  there is one, is on its own `push` run.
- **`success` with `check` steps recorded** — Actions ran the whole check and it passed. A genuine second
  opinion, and the only reading that is one in the affirmative.
- **`failure` with steps recorded and one of them failed** — a real second opinion in the negative. Read that
  step's log and treat it as this section's red `main`.

The `main-red` issue is no safeguard against any of this, because `ci.yml` produces it. `main-state` needs
`check` and runs only on a `success` or `failure` from it, so a blocked run fails it in three seconds along
with everything else and a cancelled run skips it — either way **no
`main-red` issue can ever be opened**:

```bash
# is anything tracking a red main right now?
gh api "repos/$R/issues?labels=main-red&state=open" --jq '.[] | "\(.number) \(.title)"'
```

An empty answer there means `main` is green, **or** that no run has been able to reach the question. Nothing
has ever carried the label. Resolve it with the jobs call above rather than believing either reading.
(`main-state` ignoring a cancelled run is correct and not a second bug: a run with no verdict in it must not
open an issue claiming `main` is red. What was wrong was that no run could finish.)

The only verdict on a tree is `bash scripts/agent-check.sh` passing in this working directory, on that tree.
That is what design §12.4 makes the gate and what both routines run before they push. Actions passing does
not stand in for it, and a push is still only ever a tree the sandbox check has just passed on. Nothing in
the Actions tab adds to that or overrides it — when Actions is working it corroborates it from a different
machine, and when it is not the gate is unchanged.

## Running and viewing the app

`scripts/agent-check.sh` installs dependencies, prepares a throwaway database, seeds demo data, runs typecheck, lint,
unit tests with a coverage table (design §12.1), the `/infra` check (T29: `cdk synth` and the stack's own unit
tests, with no AWS account and no Docker — `scripts/infra-check.sh`), the Playwright suite, and last the
verification step of the §11.4 restore drill (T33: `npm run restore:drill` against the database the suite has
just driven — `docs/BACKUPS.md` explains what it is rehearsing), and writes
screenshots to `e2e/screenshots/`. Both agents read those PNGs to
see what they built. `npm run e2e:ui` is for humans.

The script empties `e2e/screenshots/` before it does anything else, next to the mailboxes and the throwaway
database (T43). So the directory holds the output of the last run of the script and nothing else: no PNG from
an earlier run, and none from a check of another branch. If a run dies before Playwright, the directory is
empty rather than stale. A file that is there is evidence about the branch and the commit just checked; a
screen whose file is missing is a screen this run did not take, which is itself worth noticing.

### A clean start, so the verdict is about this branch (T45, T68)

Unlike a CI runner, both routines reuse one working directory across branch switches, so the script clears
what the last run left behind before it does anything that can fail: the mailboxes, the `sweetspot_e2e`
database, the generated route types in `.next/types`, and — inside the `/infra` step — the cloud assembly in
`infra/cdk.out`. The route types are the one that used to bite.
`tsconfig.json` includes `.next/types/**/*.ts`, and the typecheck step runs before the build inside the e2e
step, so a run that did not clear it typechecked the *previous* branch's route types: a route that branch had
and this one does not fails to resolve its page, and `== typecheck` fails with `TS2307` on files nobody wrote.
Twelve of them cost the reviewer run of 2026-10-14 most of a run.

So treat a typecheck failure as this branch's. Neither routine needs to `rm -rf .next` by hand, and neither
should: `.next/types` is the only part of `.next` the typecheck reads, `next build` rewrites it in full, and
taking the rest would throw away `.next/cache` and turn every run's build from about 40 seconds into about 63.

`infra/cdk.out` is the same shape of problem with a different symptom, so treat the `/infra` step's closing
line the same way (T68). `cdk synth` writes the stacks this branch builds and leaves every other file in the
directory alone, and the line used to list `cdk.out/*.template.json` — so after a branch that builds a stack
this one does not, it named that stack as having synthesized. `scripts/infra-check.sh` now removes `cdk.out`
before its install and reads the stacks out of the `cdk.out/manifest.json` the synth just wrote, which is
cheap (the directory is about 420K and a synth about seven seconds either way) and makes the line unable to
name a stack the branch cannot build. Quote it as evidence; it is about this tree. If it is missing where you
expected it, the step failed: an assembly with no stack, or one naming a template that is not on disk, is now
`infra-check: ...` on stderr and a non-zero exit rather than a confident line.

### What is in a screenshot (T57, T77, T81, T109)

Every spec takes its shots through `shot()` in `e2e/shot.ts`, which decides how much of the page is in the
image: the desktop project shoots the whole document, where a table row is one line of it, and the mobile
project shoots its 375px viewport, where it is not — a full-page phone shot of the provider dashboard is as
tall as the practice's visit list and came out 20,000 pixels of three-pixel rows. A spec overrides that
where the subject asks for it: `WHOLE_PAGE` for a page bounded by its own content and short enough to read
whole — a patient screen, the landing page — `MODAL` for a dialog, which is one viewport's worth of subject
at either width, `SCREENFUL` for the provider dashboard, whose height is the practice's visit list on either
project, and `scrollTo` to put the table card or one booked row in the shot before it is taken. Add a shot by
calling the helper; a new `page.screenshot` call is the thing this replaced, and `npm run lint` now says so.

The printed one-pager is **not** one of the whole-page subjects, and this list used to say it was (T109).
Its height is its own design rather than the practice's data, which is the test `WHOLE_PAGE` is written
against — but it fails the other half of it, the one about fitting in about two phone screens. Measured on
the seeded visit: the sheet is 1,296 CSS pixels in the desktop project's two columns and 1,987 in the
phone's one, in a 2,091-pixel document, which is three phone screens and, at the phone's 2.625 device
scale, a **5,489-pixel** PNG — past the §12.3 size gate's `MAX_HEIGHT` of 4,000 and past what a reviewer
can read. The desktop shots of the same sheet are 720 to 1,563 pixels and hold it whole.

So the sheet keeps the per-project default, and a phone shot of it is anchored with `scrollTo` on the part
its spec took it for. No one frame holds the sheet, so between them the shots cover it: the two flag blocks
and the single-day sub-line at the top (`e2e/flags.spec.ts`, `e2e/review.spec.ts`), which need no anchor and
say so where they are taken; `.sour-print-words` at the bottom of the frame for the journey, which brings
the patterns, the questions and the patient's own words into one picture — the §12.2 handover the journey
exists to check; and the chart card for both shots in `e2e/print.spec.ts`, which share that anchor so the
pair is a before-and-after of one part of the sheet, screen media against print media, rather than two
different parts. `provider-print-no-clinician` is the one phone shot that holds a whole sheet, because that
visit has nothing to summarize. Anchor a new phone shot of the sheet the same way; `WHOLE_PAGE` on it is a
5,489-pixel column the gate will stop.

The desktop default was wrong about the dashboard too (T81). A desktop row is one line of a table, but the
list still grows a row with every visit the suite books, so the whole document of it reached 7,015 pixels
and the §12.3 size gate was excusing four desktop dashboard shots by name. Each of those shots was taken to
show one row and already said which one in `scrollTo`, so all seven dashboard shots now take `SCREENFUL`
and stay the same size however much the stack grows. `e2e/screenshot-exceptions.json` is down to the one
entry that is not waiting for a fix: `mobile-375-patient-summary-full.png`, a page that is long by its own
design and worth having whole.

The helper also freezes the page's transitions, for every shot (T77). `page.screenshot` leaves CSS running
unless it is passed `animations: "disabled"`, so the shutter could open part-way through one and write a state
the product is never in: the Sweetie progress bar (`transition: width 500ms`) gave both routines a
`journey-09` labelled 100% over a bar filled 53% of the way, and a reviewer had to spend time working out
that the bug was in the picture and not in the product. Read a PNG as the finished frame of whatever it is
showing. A spec whose subject is a transition can pass `animations: "allow"`, and none does.

The suite runs two app servers (T20). Port 3100 is the usual one, with no model key, and port 3101 is the same
build with a key set and `OPENAI_BASE_URL` pointing at a closed loopback port, so `e2e/degraded.spec.ts` can see
the real degraded path (design §6.3). Playwright starts them one after another, so only the first one builds.

### When the box is the problem (T89)

The check's time budgets are ceilings for something that has hung, not estimates of something healthy, because
how long a build takes is a property of the container and not of the tree. The 2026-10-10 probe measured about
40s for `npm run build` with a warm `.next/cache`, 63s cold, and about two minutes for the whole check. Runs
since have measured that same build at 4m29s, 8m12s and 11m25s on idle 4-CPU sandboxes — up to eleven times
the documented figure, on builds that exited 0 — and the runs failed in ways that named the product. So the
check now says which box it is on. Every slow stage goes through `scripts/timed.sh`, which prints
`timing: <stage> <wall time>` as the stage finishes, and the script closes with one table:

```
== timings (wall clock on this box; a stage several times its usual length is a slow box, not a red tree)
   install         1m12s
   database           9s
   typecheck         41s
   build           9m07s
   e2e             4m22s   <- failed here
   e2e-serial      1m48s
   whole check    15m31s
   for comparison, the 2026-10-10 probe: build about 40s warm, whole check about 2m.
```

`build` is in the table although it runs inside Playwright's first web server rather than in the check script:
that child inherits `CHECK_TIMINGS` and appends to the same file. The table comes from an `EXIT` trap, so a run
that died at `e2e` still prints what every stage before it cost — there is nothing to re-run to find out.

A stage several times its usual length, with no failed assertion anywhere in the output, is a slow box. The
failures it produces are all misleading in the same way: a Playwright per-test timeout names the test, and
`Timed out waiting ...ms from config.webServer` names the server, when the only thing that ran out was the
clock.

The worst of them do not look like clocks at all (T95). A wait on asynchronous work fails *inside* its test,
so Playwright reports the assertion and the last value it saw: the reviewer run of 2026-10-19 read
`data-phase` as `"none"` — which says the §7.1 enqueue path never queued the run — a summary as `"stale"` and
a transcript as `""`, on a tree where every one of them passed when re-run serially. The same no-op
`sour.run` measured 1.3s on an idle box and 27.0s under contention. A failure naming the product is therefore
not by itself evidence against the tree either; read the timings table first, as below.

When the timings say it was the box:

- **Do not revert anything.** "The state of `main`" above is about a tree that is red; this is not evidence
  about any tree.
- **Do not push.** The gate is a check that passed, and this is not one. Unfinished work goes to a `t<nn>-wip`
  branch as usual.
- **Say so on the issue**, quoting the wall times out of the table and what they are being compared against.
  Leave the ticket `in-progress` so the next run continues it: a slow box needs no human, so it is not
  `blocked`.
- The suite has three budgets, each overridable for one run by an environment variable:
  `E2E_WEBSERVER_TIMEOUT_MS` for the build behind the first web server, `E2E_TEST_TIMEOUT_MS` for one test,
  and `E2E_LOADED_TIMEOUT_MS` for one wait on asynchronous work — a client fetch painting, a `sour.run`
  draining, a code arriving in the mailbox. The first two are in `playwright.config.ts`; all three are parsed
  and defaulted in `e2e/budget.ts`, which is where the specs take theirs from. Raise them on a box slower
  than any of the figures above, and raise the last two together: a wait cannot outlast the test holding it.
  Never lower a budget to make a suite fit, and never skip or quarantine a test to get past one.
- Nothing in a spec writes a budget by hand — `npm run lint` refuses a flat `timeout:` anywhere in `e2e/`,
  which is what keeps a raised ceiling from being overtaken by a number in a spec. A wait that genuinely
  needs longer than an ordinary one asks for `DRAINED` or `loadedAtLeast(ms)` from `e2e/budget.ts`, a floor
  under the shared budget rather than a flat number beside it.
- And nothing omits one either (T124). A `timeout:` written wrong is what the rule above selects; a poll
  that passes no budget at all has no such property to select, so it passed lint and quietly took
  Playwright's own 5s `expect` default — `playwright.config.ts` sets no `expect` block, so that number is
  Playwright's and not anybody's choice, and `E2E_LOADED_TIMEOUT_MS` cannot reach it. Two sites got there
  that way, one of them `expectTranscriptUncut`'s poll behind fourteen call sites, and on a slow box they
  failed saying "the transcript never settled on the newest message" about something that was only the
  clock. `npm run lint` now refuses an `expect.poll` whose options carry no budget as well as one that
  carries a flat number.
- The one budget a slow box does **not** need raised is `GIVES_UP`, which is for a wait staged to run out:
  the three negative tests in `e2e/transcript.spec.ts` assert on `expectTranscriptUncut` giving up, so they
  spend their whole budget on every green run rather than only on a slow one. It is a quarter of
  `E2E_LOADED_TIMEOUT_MS` with 8s under it, so raising that override still moves it, and a staging duration
  that has to outlast it is derived from it rather than written beside it.

#### The box the table cannot see, and the serial re-run that can (T161)

Everything above is about a box that is visibly crawling, and the test it gives — a stage several times its
usual length — only fires when the slowness is spread across the whole run. The commoner case is one wait
losing a scheduling race, and **the timings table cannot see it at all.** The reviewer run of 2026-10-26 ran
the check twice on `main` at `7f22d3d`, untouched: the first failed on one test, the second passed 275/275.
The two tables were the same table — `e2e` 11m32s against 10m31s, the whole check 13m46s against 12m15s —
because 30s of stalled wait is 4% of an eleven-minute `e2e` stage. Meanwhile the failure named the product:
`the transcript never settled on the newest message`, which reads exactly like a §6.2 regression. A routine
following the reviewer's step 2 to the letter would have found the timings unremarkable, concluded the tree
was red, and reverted a healthy commit.

So **a normal-looking timings table does not rule out the box**, and on a failed suite it is not the evidence
to decide on. Two things in the output are, both of them below the suite's own report:

1. **What each failure was evidence about.** `e2e/budgetReporter.ts` reads every failed test as one of two
   things and says which, by name, in the run's log: a **clock** — a wait that spent its whole budget and
   gave up, naming the budget and the override that raises it — or an **assertion**, the product having
   answered wrongly with no clock involved. `lib/budgetFailure.ts` is the rule and the reasoning;
   `lib/budgetFailure.test.ts` holds it to both. A wait that ran out has not seen the product say no, it has
   stopped asking, so a run of nothing but clocks has not yet said anything about the tree.
2. **The serial re-run.** When the suite fails, `scripts/agent-check.sh` re-runs *only* the tests that
   failed, serially, once — `npx playwright test --last-failed --workers=1` — and prints both outcomes:

   ```
   == e2e (serial re-run of just the tests that failed, once)
      every failure above a clock that ran out? true
      the tests that failed in parallel all pass serially, and all of them were clocks:
      this is the box, not the tree.
   ...
   e2e: failed in parallel, serial re-run of the failures passed
   ```

   "Failed under parallelism, passed at `--workers=1`" is the diagnosis this section used to ask a routine to
   perform by hand, which cost two runs the first time it came up. It is three lines of script, so the script
   does it.

The exit status is still the verdict, and the re-run moves it in one direction only. It is cleared **only**
when every failure was a clock *and* the serial re-run passed. A failure that fails serially too is the tree,
as before. And a failure with no clock in it stays red even when the re-run passes: a product assertion that
answers differently under parallelism is nondeterminism in the product, which is a finding about the tree and
not about the box. This is deliberately not Playwright's `retries`, which `playwright.config.ts` holds at 0:
a retry would hide the first attempt inside its own report and would do it for a genuine failure too. The
parallel failure is printed in full either way.

What has not changed: a check that did not pass is not a push. When the re-run says the box, the run is a
pass and the tree can be pushed; when it says the tree, or when a non-clock failure keeps the run red, the
rules above apply unchanged — do not revert on the strength of a clock, leave the ticket `in-progress`, and
say on the issue which of the two the re-run reported.

### The journey spec (T26)

`e2e/journey.spec.ts` is design §12.2 in one test: an admin sets a practice up, staff book a visit in the
wizard, the patient verifies with the emailed code, consents, shares two exports and answers both intake
questions, and a clinician then opens the visit, waits for the `sour.run` job, signs the summary off and
prints it. Every other spec takes one screen and tries it hard; this one is the handover between the two
flows, so what the patient typed is asserted on the clinician's brief and on the printed sheet. It writes
the fifteen numbered `*-journey-NN-*.png` screenshots, in the order a practice lives them, which is the
fastest way for either routine to see the whole product in one place.

### Signing in from a test (T05)

The provider pages are behind Auth.js magic links (design §5.1), so a test that needs the dashboard has to sign
in. There is no mail server here and no inbox to read, so the local mailer does the sending: with no email
provider configured, `lib/mailer.ts` writes each message to `DEV_MAIL_DIR` as a file instead of sending it, and
`e2e/auth.ts` reads the newest link out of it. `scripts/agent-check.sh` sets `DEV_MAIL_DIR=e2e/.mail`, empties
it before the run so a stale link cannot be picked up, and sets `AUTH_SECRET` (nothing signed with it outlives
the throwaway database). Humans get the same thing from `npm run mail`.

The link is a credential, which is why it is a file rather than a log line: §10.3 keeps link tokens out of the
logs, and `npm run lint` plus `lib/log.test.ts` stop application code writing to stdout at all. Both the
mailbox directories are gitignored.

### The database in the sandbox (T01)

The app is Postgres only (design §3.2). `scripts/dev-db.sh` is the one thing that brings a server up, and it tries
three ways in order, so the same `scripts/agent-check.sh` works everywhere:

1. **`DATABASE_URL` already points at a live server** — use that server. This is how CI works: `.github/workflows/ci.yml`
   runs a `postgres:16-alpine` service container and passes its URL. The script takes the *server* from the variable and
   creates its own database on it, so a developer's data is never what gets wiped.
2. **The Docker daemon is up** — `docker compose up -d db`, the documented local path for people (`docker-compose.yml`).
3. **Neither** — start a Postgres that is already installed on the host. **This is the path the cloud sandbox takes:**
   the daemon is not running there (`docker info` fails), but the image ships PostgreSQL 16 under
   `/usr/lib/postgresql/16`, so the script starts the packaged cluster with `pg_ctlcluster` (falling back to `initdb`
   plus `pg_ctl` on a throwaway data directory) and creates the role and database. `initdb` and `postgres` refuse to run
   as root, so that work goes through the `postgres` OS account.

The check script always uses its own database, `sweetspot_e2e`, dropped and recreated on every run — the Postgres
equivalent of the old `rm -f prisma/e2e.db`. `scripts/dev-db.sh --fresh` is what does the dropping, and it only ever
touches the database named on its command line.

Two things not to reach for: `prisma migrate reset` refuses to run for an AI agent without recorded human consent, so
the clean slate comes from dropping the database in `dev-db.sh` and then `prisma migrate deploy`. And do not add a
Docker-only step to the check script; the daemon is absent here.

## GitHub from the sandbox: REST only

The cloud sandbox blocks GitHub's GraphQL endpoint, so `gh pr create`, `gh issue list`, `gh pr merge` and friends
fail with HTTP 403. `gh api` (REST) works. Use these, with `R=justinmilner1/healthcare_ai_hackathon_26_09`:

```bash
# issues by label, lowest number first. Every *listing* goes through the helper (third trap below): it is
# the one call whose wrong answer is silence, so `list` re-reads until the reads agree and prints the array
# for jq to shape.
scripts/gh-issues.sh list "repos/$R/issues?labels=ready&state=open&per_page=100" \
  | jq -r 'sort_by(.number)[] | "\(.number) \(.title)"'
# read one issue (body has the design sections and acceptance criteria)
gh api "repos/$R/issues/12" --jq '.title, .body'
# labels: add / remove
gh api -X POST "repos/$R/issues/12/labels" -f 'labels[]=in-progress'
gh api -X DELETE "repos/$R/issues/12/labels/ready"
# comment on an issue or pull request
gh api -X POST "repos/$R/issues/12/comments" -f body='...'
# a longer comment from a file (keeps quoting sane)
gh api -X POST "repos/$R/issues/12/comments" -F body=@/tmp/comment.md
# close an issue (the reviewer, once the landed work meets the ticket)
gh api -X PATCH "repos/$R/issues/12" -f state=closed
# the tickets waiting for review, lowest number first
scripts/gh-issues.sh list "repos/$R/issues?labels=review&state=open&per_page=100" \
  | jq -r 'sort_by(.number)[] | "\(.number) \(.title)"'
# ci on main, when Actions is running (see "The state of main")
gh api "repos/$R/actions/workflows/ci.yml/runs?branch=main&per_page=10" --jq '.workflow_runs[] | "\(.head_sha[0:7]) \(.event) \(.conclusion)"'
# the next ticket number: the highest T<nn> over every issue AND pull request, any state, plus one
scripts/gh-issues.sh next-number      # prints T<nn>, or exits non-zero; never a number from a short walk
# resolve "Depends on: T41": the issue that owns the number, pull requests excluded
scripts/gh-issues.sh depends T41      # one "<number> <state> <title>" line per owning issue
# every page of a listing as one array, for anything the two commands above do not cover
scripts/gh-issues.sh pages "repos/$R/issues?state=all&per_page=100" | jq -r '.[].title'
```

Three traps, each of which silently gives a wrong answer rather than an error:

- **`gh api --paginate` does not work here.** It follows GitHub's `Link` header, whose `rel="next"` is a
  numeric-id path (`repositories/{id}/...`), and the sandbox proxy refuses those with HTTP 403. It prints the
  error to stderr and the first page to stdout, so a pipeline that ignores stderr looks like it succeeded.
- **`per_page=100` is one page, not "everything".** This repository held 129 issues-plus-pull-requests when T48
  was written — two pages — so anything that needs all of them walks pages. `scripts/gh-issues.sh pages` is
  that walk: it stops at the first page shorter than `per_page`, and when every page it is allowed to read
  comes back full it **fails** rather than hand back the first few as though they were all of them
  (`GH_ISSUES_MAX_PAGES`, 6 by default — raise it as the stack grows). The `&state=open` calls higher up are
  still well inside one page.
- **A listing can answer `HTTP 200` with `[]` on a repository that has issues (T127).** Measured on
  2026-10-22: 8 of 25 `issues?state=open&per_page=100` reads, 3 of 25 `labels=review` reads (and 4 of 12 in
  an earlier burst), and 1 of 5 passes of the next-number walk lost a page. `gh` exits **0**; the response
  carries `Server: github.com`, `Content-Length: 2`, a fresh `X-Github-Request-Id` and 14917 of 15000 rate
  limit left, and every empty body shares one `Etag` (`9e006b32…`) — a replica serving an empty index, not
  the proxy, not a rate limit, and not the label filter, since the unfiltered listing is affected worst.
  **An empty list from a routine's opening read is not evidence that there is nothing to do.** It is the
  answer that means "stop": the builder's step 2 ends the run, the reviewer's step 1 skips every ticket
  waiting, and the next-number rule fails *towards a duplicate* — five identical passes during that
  measurement returned `max=125, 125, 62, 125, 125`, and the third would have filed the next bug as **T63**,
  a number taken since September. So read listings through `scripts/gh-issues.sh`, which re-reads until two
  consecutive reads agree, treats fewer rows than it has already seen as the suspect direction, requires
  four consecutive empties before it will call a listing empty (two in a row land about 11% of the time at
  the measured rate, which is a stopped routine most days), and exits non-zero rather than print an answer
  nothing corroborates. Its header comment states the rule and why it is enough; `lib/ghIssues.test.ts`
  holds it to that against a stubbed flaky listing. A single issue (`issues/12`) is an object rather than a
  list and needs none of this: it cannot come back empty, and a missing one is a loud 404.

`git push` works with the sandbox's credentials, to `main` and to a `t<nn>-wip` branch. The proxy refuses branch
deletion; a leftover `-wip` branch is harmless, say so in the comment and move on.

### A shallow checkout, and the divergence that is not one (T103)

The third trap of that genre is not a REST call but the git checkout underneath it. This container clones at a
bounded depth, so the working directory arrives **shallow**: `git rev-parse --is-shallow-repository` prints
`true` and `.git/shallow` holds one graft line per truncated lineage. Nothing announces it. Once `origin/main`
has advanced past the graft point, the opening `git pull` of either procedure fails without the word "shallow"
anywhere in it:

```
$ git fetch origin && git checkout main && git pull
Your branch and 'origin/main' have diverged,
and have 51 and 50 different commits each, respectively.
fatal: Need to specify how to reconcile divergent branches.
```

`main` had not diverged. That is the reviewer run of 2026-10-19, on a `main` that was 0 commits ahead of
`origin/main` and 162 behind. Each ref was truncated at a different graft, so the two had no reachable common
ancestor, and git reports "no common ancestor" as the count of everything it can still see on either side.
After `git fetch --unshallow origin` the same two refs were an ordinary fast-forward.

**Deepen before you pull, and reconcile explicitly.** Step 1 of both procedures above opens with:

```bash
git fetch --unshallow origin || git fetch origin   # deepen; the fallback is for an already-complete clone
git checkout main
git pull --ff-only                                 # an honest divergence stops here instead of being merged
```

`--unshallow` is not a no-op on a complete clone — it exits 128 with
`fatal: --unshallow on a complete repository does not make sense`, having changed nothing — which is what the
`||` is for. A guard reads the same: `git rev-parse --is-shallow-repository` prints `true` or `false`, so
`[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch --unshallow origin` is the conditional form.

**What not to reach for when that message appears.** The danger is not the error, it is the cures. None of
these is a force-push, so neither `AGENTS.md` nor the routine prompts stop them, and against a graft all three
are destructive:

- **`--allow-unrelated-histories`** (or any `git pull --no-rebase` that git's hint suggests) writes a merge of
  two truncated histories, and pushing it puts a duplicated tree on `main`.
- **`git reset --hard origin/main`** throws away whatever was local without printing what it dropped.
- **Any `git pull` that is not `--ff-only`**, which is the whole point of the flag: on a real divergence it
  refuses, and a refusal is the correct outcome for a routine that is only ever meant to fast-forward.

**One line tells the two apart.** `git merge-base main origin/main` prints the common ancestor and exits 0 on a
real divergence; on a graft it prints nothing and exits 1. Two confirmations of the same thing:
`git rev-parse --is-shallow-repository` says `true`, and `git log --oneline --max-parents=0 origin/main` names a
"root" commit with a `T<nn>:` message — a ticket commit cannot be the start of this repository, so that is a
graft.

**A graft also shortens the history either routine can ask about.** `git log` and `git bisect` cannot see past
one. The builder's committed range can fall entirely outside what is on disk, and asking for a range whose
first commit *is* the graft fails on the `^` rather than on the range — the graft has no parent to name, so git
calls the whole argument unknown and says nothing about shallowness:

```
$ git log -p <graft sha>^..<last>
fatal: ambiguous argument '<graft sha>^..<last>': unknown revision or path not in the working tree.
```

A bisect is quieter still: it searches only the commits after the graft, so "find the commit that broke it" can
come back with the oldest commit it was allowed to look at. Deepen first, then read history — the reviewer's
step 2 and the revert in step 5 both depend on it.

## Environment facts (from the probe on 2026-10-10)

Node 22, npm 10, git, `gh` 2.89, `jq` 1.7, Python 3.11, Docker 29; 4 CPUs, 15 GB RAM; npm registry reachable.
(`jq` is what `scripts/gh-issues.sh` shapes and compares listings with, and what the snippets above pipe
into: the helper prints an array rather than taking a `--jq` expression, so one read can be shaped more than
one way. It needs no `npm install`, which matters — both procedures ask GitHub what to do before anything is
installed.) The Playwright
CDN is blocked but a Chromium is pre-installed under `/opt/pw-browsers`; `scripts/agent-check.sh` finds it. The
full check took about two minutes *on that box*; containers since have been several times slower, so read the
timings table the check prints rather than this line ("When the box is the problem"). Both routines are one
GitHub account, and the sandbox proxy refuses branch
deletion. GitHub Actions may or may not be running on the account (T75); nothing either routine does depends
on it.

## Rules both follow

- Push to `main` only a tree `scripts/agent-check.sh` has just passed on, in this working directory. Rebase onto
  `origin/main` before pushing; never force-push anything on origin.
- Unfinished work never lands on `main`: it goes to a `t<nn>-wip` branch with a comment on the issue.
- Never commit secrets, `.env`, or real patient data. Fixtures are synthetic.
- Keep the contract in `lib/types.ts` and the agent architecture in `docs/AGENT_ARCHITECTURE.md` unless the ticket says otherwise.
- When in doubt, leave a comment on the issue and move on rather than guess.
