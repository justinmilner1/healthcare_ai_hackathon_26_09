#!/usr/bin/env bash
# Run one stage of scripts/agent-check.sh and say, in the log, how long the box took over it (T89).
#
# The check's budgets were written for the sandbox the 2026-10-10 probe measured, and when a container is
# several times slower than that the run does not fail saying so: a Playwright per-test timeout names the
# test, and the `webServer` timeout names the server, when the only thing that went wrong was the clock.
# Three builder and reviewer runs spent most of their time re-running a tree that was never broken. A wall
# time beside every slow stage is what makes that one read of the log instead: a stage that normally takes
# forty seconds and took nine minutes is a slow box, and the same stage failing in forty is a red tree.
#
#   bash scripts/timed.sh <label> <command> [args...]
#
# The line goes to stderr, because the one caller that is not the check script is Playwright's `webServer`,
# which ignores a server's stdout and pipes its stderr (so the build's own time reaches the run's log).
# With CHECK_TIMINGS set to a writable path, the label, the seconds and the exit status are also appended
# there as TSV, which is how agent-check.sh collects stages that ran inside another process — the `next
# build` behind the first web server above all — into the one table it prints at the end.
#
# The command's own exit status is passed through untouched: this wrapper must be invisible to the verdict.
# `set -e` is deliberately not on. The whole point is to report the time of a stage that failed, so the
# failure has to be caught and re-raised rather than abort the script between the clock and the echo.
set -uo pipefail

label="${1:?usage: timed.sh <label> <command> [args...]}"
shift

# Whole seconds. Nothing here is measuring anything short enough for a millisecond to matter, and `date +%s`
# is in every shell this runs in, where bash's own $EPOCHREALTIME wants 5.0.
start=$(date +%s)
"$@"
status=$?
elapsed=$(( $(date +%s) - start ))

# "9m07s" past a minute, "47s" below it: a reader comparing against a documented "about 40s" should not have
# to divide 547 by 60 to see that the box is the problem. Padded to agree, digit for digit, with the table
# agent-check.sh prints from the same numbers at the end — the same stage read twice should not look like two.
if [ "$elapsed" -ge 60 ]; then
  human="$(printf '%dm%02ds' "$((elapsed / 60))" "$((elapsed % 60))")"
else
  human="${elapsed}s"
fi

printf 'timing: %s %s%s\n' "$label" "$human" "$([ "$status" -eq 0 ] || printf ' (failed, exit %s)' "$status")" >&2
if [ -n "${CHECK_TIMINGS:-}" ]; then
  printf '%s\t%s\t%s\n' "$label" "$elapsed" "$status" >> "$CHECK_TIMINGS" 2>/dev/null || true
fi

exit "$status"
