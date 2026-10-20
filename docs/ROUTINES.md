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
| `main-red` | Not a ticket: `ci` is failing on `main` right now. Opened and closed by `ci.yml` itself (T47). `main-state` is an Actions job, so while Actions is blocked the label cannot appear at all, and its absence is not a green signal (T92) |

The reviewer closes the issue once what landed meets the ticket. Bugs the reviewer finds become new issues labeled
`ready` and `bug`.

### Where a new ticket's number comes from

**The highest `T<nn>` across every issue *and* pull request, in *any* state, plus one.** The snippet for it is
[below](#github-from-the-sandbox-rest-only), next to the other REST calls.

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

1. `git fetch`, check out `main`, pull.
2. Pick the ticket: the lowest-numbered issue labeled `changes-requested`; otherwise the lowest-numbered `ready`. Skip anything `blocked`. Resolve each of its `Depends on: T<nn>` lines with the dependency snippet below and require that ticket closed — the snippet excludes pull requests, and two numbers name two tickets apiece, so check that table when it returns more than one row. If none, stop.
3. Label it `in-progress`, remove `ready` or `changes-requested`, and comment `Builder run started <UTC time>` on the issue. If a previous run left a `t<nn>-wip` branch on origin, `git merge origin/t<nn>-wip` into `main` locally and continue from there.
4. Read the cited design sections and the acceptance criteria. Implement the whole ticket on `main`, locally. Small, focused commits, every message starting `T<nn>:` — that prefix is how the reviewer finds the ticket's commits.
5. Run `scripts/agent-check.sh`. Fix what fails — but read the timings table it closes with first: a stage several times its usual length and no failed assertion is a slow box, not a red tree ("When the box is the problem" below). Look at the screenshots in `e2e/screenshots/` — the script empties it first, so everything in it is from this run — and confirm the affected screens look right. Copy the relevant ones to `docs/screenshots/tickets/t<nn>/` and commit them.
6. Land it: `git pull --rebase origin main`. If that brought in anything, run the check again on the rebased tree. Then `git push origin main`. If the push is rejected because `main` moved again, rebase, re-check, push. Never force-push.
7. Comment on the issue with the commit range (`<first sha>..<last sha>` on `main`), what changed, the design sections fulfilled, the exact verification commands and their results, and the paths of the committed screenshots. Label the issue `review`, remove `in-progress`. Delete the `t<nn>-wip` branch if there was one (`git push origin --delete t<nn>-wip`; if the proxy refuses, leave it and say so in the comment).
8. If the ticket cannot be finished (missing credential, unclear design) or the run is out of time: do not push unfinished work to `main`. Push it to a branch `t<nn>-wip`, comment on the issue with what is done and what remains, and leave `in-progress` (out of time) or label `blocked` (needs a human), removing `in-progress`.

## The reviewer

Runs every three hours. Reviews the tickets labeled `review`, lowest number first, up to three per run, then sweeps `main`.

1. `git fetch`, check out `main`, pull. Run `scripts/agent-check.sh` once, on `main` as it is now; every review below reads that result and those screenshots. The run starts from an empty `e2e/screenshots/`, so the PNGs are this tree's and no earlier run's.
2. For each ticket: find its commits — the builder's comment names the range, and `git log --oneline origin/main --grep='^T<nn>'` finds them by the message prefix. Read the diff (`git log -p <first>^..<last>`), the issue body, and the design sections it cites. Compare the result with the acceptance criteria, line by line; read the code, not just the comment.
3. Small problems (naming, a missing edge case, a lint warning, a missing test): fix them on `main`, commit with a message starting `Review T<nn>:`, run the check, `git pull --rebase origin main`, push. Note each fix in your comment.
4. If it matches: comment on the issue naming the design sections it fulfills, the commits you read, and what you checked, then close the issue and remove `review`.
5. If it does not: comment with a precise numbered list, each item naming the criterion or design section and exactly what is missing or wrong, with file paths. Label the issue `changes-requested`, remove `review`. The builder fixes forward on `main`; nothing is reverted for a gap. Revert (`git revert`, then the check, then push) only when a commit has broken the check on `main` and the fix is not obvious — a check that ran out of time on a slow box has broken nothing, so check the timings table before you revert — then say which commit and why in the comment.
6. Then sweep: read the state of `main` below — a `main-red` issue, when Actions is running, says what broke before you run anything. Open the app, click through the two flows. Anything broken or drifting from the design becomes a new issue labeled `ready` and `bug`, with steps to reproduce, placed before the next feature ticket in numbering if it blocks it. Take its `T<nn>` from the rule above — the highest across every issue and pull request, any state, plus one — and recompute it for each issue you file in the same sweep, so two bugs in one run do not land on one number.

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

Actions needs billing on the account to run at all (T75), and a blocked account does not look like silence — it
looks like a wall of red (T92). The runs are still created, on every push to `main` and on the hourly backstop;
they are allocated no runner; and each one fails in two to three seconds with **zero steps recorded**. So the
first snippet below reports `completed/failure` against commits whose diffs were never executed:

```bash
# the ci runs on main, newest first: run id, sha, what triggered it, verdict
gh api "repos/$R/actions/workflows/ci.yml/runs?branch=main&per_page=10" \
  --jq '.workflow_runs[] | "\(.id) \(.head_sha[0:7]) \(.event) \(.status)/\(.conclusion // "pending") \(.created_at)"'
# 39372059111 81b5401 push     completed/failure 2026-10-20T04:54:39Z
# 39360225788 5212272 push     completed/failure 2026-10-20T02:40:55Z
# 39352149970 5f708ef schedule completed/failure 2026-10-20T01:12:39Z
```

**Never read a red `ci` run as a verdict on a tree before asking whether it ran anything.** That is one more
call, on a run id the snippet above prints:

```bash
# did this run execute anything? a job with steps=0 and a sub-five-second duration did not
gh api "repos/$R/actions/runs/39372059111/jobs" \
  --jq '.jobs[] | "\(.name) \(.conclusion) steps=\(.steps|length) \(.started_at) \(.completed_at)"'
# check      failure steps=0 2026-10-20T04:54:39Z 2026-10-20T04:54:42Z
# sweep      skipped steps=0 2026-10-20T04:54:39Z 2026-10-20T04:54:39Z
# main-state failure steps=0 2026-10-20T04:54:42Z 2026-10-20T04:54:45Z
```

That call separates the two cases the `conclusion` field cannot:

- **`steps=0`, and the job started and completed within about five seconds** — the account is blocked. The job
  was never given a runner, so it checked out nothing, installed nothing, built nothing and asserted nothing.
  It is **never** grounds for a revert, not under the reviewer's step 5 and not under the "fix it on `main`
  first" rule at the top of this section, and it says nothing at all about any commit the run names. Note it on
  the ticket in hand if it is worth noting, and carry on.
- **Steps recorded, one of them failed** — a real second opinion. Read that step's log and treat it as this
  section's red `main`.

So the Actions API has three things to say, not two, and only the third is a red tree: Actions cannot run,
Actions ran and passed, Actions ran and failed.

The `main-red` issue is no safeguard against the confusion, because Actions produces it too. `main-state` is a
job in `ci.yml`, so while the account is blocked it fails in three seconds along with the rest, and **no
`main-red` issue can ever be opened**:

```bash
# is anything tracking a red main right now? an empty answer means EITHER main is green OR Actions cannot run
gh api "repos/$R/issues?labels=main-red&state=open" --jq '.[] | "\(.number) \(.title)"'
```

Nothing has carried the label since it was introduced, which is what a blocked account looks like from that
call: indistinguishable from a `main` that has never been red. Resolve it with the jobs call above rather than
believing either reading.

The only verdict on a tree is `bash scripts/agent-check.sh` passing in this working directory, on that tree.
That is what design §12.4 makes the gate and what both routines run before they push, and while Actions is
blocked it is the *only* evidence anyone has. Nothing in the Actions tab adds to it or overrides it.

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

### What is in a screenshot (T57, T77, T81)

Every spec takes its shots through `shot()` in `e2e/shot.ts`, which decides how much of the page is in the
image: the desktop project shoots the whole document, where a table row is one line of it, and the mobile
project shoots its 375px viewport, where it is not — a full-page phone shot of the provider dashboard is as
tall as the practice's visit list and came out 20,000 pixels of three-pixel rows. A spec overrides that
where the subject asks for it: `WHOLE_PAGE` for a page bounded by its own content (a patient screen, the
landing page, the printed sheet), `MODAL` for a dialog, which is one viewport's worth of subject at either
width, `SCREENFUL` for the provider dashboard, whose height is the practice's visit list on either project,
and `scrollTo` to put the table card or one booked row in the shot before it is taken. Add a shot by
calling the helper; a new `page.screenshot` call is the thing this replaced, and `npm run lint` now says so.

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
# issues by label, lowest number first
gh api "repos/$R/issues?labels=ready&state=open&per_page=100" --jq 'sort_by(.number)[] | "\(.number) \(.title)"'
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
gh api "repos/$R/issues?labels=review&state=open&per_page=100" --jq 'sort_by(.number)[] | "\(.number) \(.title)"'
# ci on main, when Actions is running (see "The state of main")
gh api "repos/$R/actions/workflows/ci.yml/runs?branch=main&per_page=10" --jq '.workflow_runs[] | "\(.head_sha[0:7]) \(.event) \(.conclusion)"'
# the next ticket number: the highest T<nn> over every issue AND pull request, any state, plus one
n=$(for p in 1 2 3 4; do gh api "repos/$R/issues?state=all&per_page=100&page=$p" --jq '.[].title'; done \
      | grep -oE '^T[0-9]+' | tr -d T | sort -n | tail -1); echo "T$((n + 1))"
# resolve "Depends on: T41": the issue that owns the number, pull requests excluded
for p in 1 2 3 4; do gh api "repos/$R/issues?state=all&per_page=100&page=$p" \
      --jq ".[] | select(.pull_request == null) | select(.title | startswith(\"T41:\")) | \"\(.number) \(.state) \(.title)\""; done
```

Two pagination traps, both of which silently give a wrong answer rather than an error:

- **`gh api --paginate` does not work here.** It follows GitHub's `Link` header, whose `rel="next"` is a
  numeric-id path (`repositories/{id}/...`), and the sandbox proxy refuses those with HTTP 403. It prints the
  error to stderr and the first page to stdout, so a pipeline that ignores stderr looks like it succeeded.
- **`per_page=100` is one page, not "everything".** This repository held 129 issues-plus-pull-requests when T48
  was written — two pages — so the two snippets above walk pages explicitly and keep a spare page or two; add
  pages as the stack grows. The `&state=open` calls higher up are still well inside one page.

`git push` works with the sandbox's credentials, to `main` and to a `t<nn>-wip` branch. The proxy refuses branch
deletion; a leftover `-wip` branch is harmless, say so in the comment and move on.

## Environment facts (from the probe on 2026-10-10)

Node 22, npm 10, git, `gh` 2.89, Python 3.11, Docker 29; 4 CPUs, 15 GB RAM; npm registry reachable. The Playwright
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
