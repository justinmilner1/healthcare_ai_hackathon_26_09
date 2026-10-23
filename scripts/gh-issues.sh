#!/usr/bin/env bash
# A GitHub issue listing a routine can act on (T127).
#
# `gh api "repos/$R/issues?..."` from this sandbox intermittently answers HTTP 200 with an empty array on a
# repository that has issues. Measured on 2026-10-22: 8 of 25 unfiltered `state=open` listings, 3 of 25
# `labels=review` listings, and 1 of 5 passes of the next-number page walk lost a page — with `gh` exiting 0,
# a fresh `X-Github-Request-Id`, `Content-Length: 2` and 14917 of 15000 rate limit left. It is not the proxy,
# not a rate limit and not the label filter; every empty body shared one Etag, which is what a replica
# serving an empty index looks like.
#
# An empty list is not a visible failure in either routine. It is a valid answer meaning "nothing to do":
# the builder's step 2 ends the run, the reviewer's step 1 skips every ticket under review, and the
# next-number walk fails *towards a duplicate* `T<nn>` — five identical passes during that measurement
# returned max=125, 125, 62, 125, 125, and the third would have filed the next bug as T63. docs/ROUTINES.md
# calls a duplicate number "the one piece of state the whole stack rests on".
#
# So no listing leaves this script on the strength of one read.
#
# The rule, and why it is enough:
#
#   * An answer *with rows* is accepted when two consecutive reads are byte-identical once canonicalised
#     (`jq -S -c`, so a replica that serialises differently is not mistaken for different data) and carry no
#     fewer rows than the largest read of this run. Agreement alone would accept a shrunken answer twice
#     over; "no fewer rows than we have already seen" is the direction the fault runs in, and together they
#     mean the answer is corroborated rather than merely repeated.
#   * An answer with *no rows* is accepted only after GH_ISSUES_EMPTY_READS (4) consecutive empty reads, with
#     no read of this run having returned a single row. Two consecutive empties are not enough and one retry
#     is nowhere near: at the measured rate of about one empty in three, two in a row land about 11% of the
#     time on a listing that has rows — a stopped routine most days, across a two-hourly builder and a
#     three-hourly reviewer. Four in a row is about 1.2%, and one row seen anywhere in the run cancels the
#     empty answer outright instead of being averaged into it.
#   * Otherwise, after GH_ISSUES_MAX_READS (8) reads, exit 3 naming the query and the row count of every
#     read. A loud failure is the whole point: it is what the silent empty list was pretending not to be.
#
# Not the Etag: `9e006b32…` is good evidence about where the fault is but a poor test — it is one replica's
# body hash rather than a documented signal, and a second bad replica would read as healthy. Agreement
# across reads does not need to know what the fault is.
#
# Usage:
#   scripts/gh-issues.sh list "repos/$R/issues?labels=ready&state=open&per_page=100"   # one agreed listing
#   scripts/gh-issues.sh pages "repos/$R/issues?state=all&per_page=100"                # every page, as one array
#   scripts/gh-issues.sh next-number                                                   # prints T<nn>
#   scripts/gh-issues.sh depends T41                                                   # the issue owning T41
#
# `list` and `pages` print a compact JSON array on stdout for the caller's own `jq` to shape, so the
# documented snippets keep their `--jq` expressions (as a `jq` argument now, not gh's). Every command exits
# non-zero rather than printing an answer it cannot corroborate.
set -euo pipefail

MAX_READS="${GH_ISSUES_MAX_READS:-8}"
EMPTY_READS="${GH_ISSUES_EMPTY_READS:-4}"
SLEEP_BETWEEN="${GH_ISSUES_SLEEP:-1}"
MAX_PAGES="${GH_ISSUES_MAX_PAGES:-6}"

die() {
  echo "gh-issues: $*" >&2
  exit 3
}

# The repository to ask about: $R as both routine prompts set it, else origin.
repo() {
  if [ -n "${R:-}" ]; then
    printf '%s' "$R"
    return 0
  fi
  local url
  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  url="$(printf '%s' "$url" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  [ -n "$url" ] || die "no repository: set R=owner/name, or run this inside the checkout"
  printf '%s' "$url"
}

# The page size the query asked for, which is how a corroborated short page is known to be the last one.
# GitHub's own default is 30 when the query does not say.
page_size() {
  local n
  n="$(printf '%s' "$1" | sed -nE 's#.*[?&]per_page=([0-9]+).*#\1#p')"
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then printf '%s' "$n"; else printf '30'; fi
}

# One read, canonicalised. Non-zero for anything that is not a JSON array: a `gh` failure, an error object,
# a half-written body. Those are retried like a disagreement rather than printed as an answer.
read_once() {
  local body
  body="$(gh api "$1")" || return 1
  printf '%s' "$body" | jq -S -c 'if type == "array" then . else error("not an array") end' 2>/dev/null || return 1
}

# One listing, read until the reads agree. Prints the array, or exits 3.
stable_listing() {
  local query="$1"
  local attempt=0 body="" previous="" rows=0 most=0 rows_seen=0 empty_streak=0 history=""
  while [ "$attempt" -lt "$MAX_READS" ]; do
    if [ "$attempt" -gt 0 ]; then sleep "$SLEEP_BETWEEN"; fi
    attempt=$((attempt + 1))
    if ! body="$(read_once "$query")"; then
      history="$history error"
      previous=""
      empty_streak=0
      continue
    fi
    rows="$(printf '%s' "$body" | jq 'length')"
    history="$history $rows"
    if [ "$rows" -gt 0 ]; then
      rows_seen=1
      empty_streak=0
    else
      empty_streak=$((empty_streak + 1))
    fi
    if [ "$rows" -gt "$most" ]; then most="$rows"; fi
    if [ "$rows" -gt 0 ] && [ "$rows" -eq "$most" ] && [ "$body" = "$previous" ]; then
      printf '%s\n' "$body"
      return 0
    fi
    if [ "$rows" -eq 0 ] && [ "$rows_seen" -eq 0 ] && [ "$empty_streak" -ge "$EMPTY_READS" ]; then
      printf '[]\n'
      return 0
    fi
    previous="$body"
  done
  die "$query: $attempt reads never agreed (rows per read:$history); refusing to answer"
}

# Every page of a listing as one array. Each page goes through stable_listing, so a page that cannot be
# corroborated stops the walk with a non-zero exit instead of shortening the answer — which is the shape of
# the next-number bug: one lost page lowers the maximum rather than erroring.
stable_pages() {
  local query="$1"
  local size page=1 body rows parts=""
  size="$(page_size "$query")"
  while [ "$page" -le "$MAX_PAGES" ]; do
    body="$(stable_listing "${query}&page=${page}")" || exit 3
    parts="$parts$body
"
    rows="$(printf '%s' "$body" | jq 'length')"
    # A short page is the last page — but only because this one is corroborated. Reading a short page as
    # the end is exactly what an empty replica response would exploit, which is why the check is here and
    # not in stable_listing.
    if [ "$rows" -lt "$size" ]; then
      printf '%s' "$parts" | jq -s -c 'add // []'
      return 0
    fi
    page=$((page + 1))
  done
  die "$query: the walk filled all $MAX_PAGES pages and the last one was still full, so there are more; raise GH_ISSUES_MAX_PAGES"
}

cmd_list() {
  [ $# -eq 1 ] || die "usage: gh-issues.sh list <api path and query>"
  stable_listing "$1"
}

cmd_pages() {
  [ $# -eq 1 ] || die "usage: gh-issues.sh pages <api path and query, without &page=>"
  stable_pages "$1"
}

# The next ticket number: the highest T<nn> across every issue *and* pull request, in any state, plus one
# (docs/ROUTINES.md, "Where a new ticket's number comes from"). A page that cannot be read is a failure here,
# never a lower maximum.
cmd_next_number() {
  local rows highest
  rows="$(stable_pages "repos/$(repo)/issues?state=all&per_page=100")" || exit 3
  highest="$(printf '%s' "$rows" | jq -r '[.[].title | capture("^T(?<n>[0-9]+)") | .n | tonumber] | max // empty')"
  [ -n "$highest" ] || die "no T<nn> title in any of $(printf '%s' "$rows" | jq 'length') items; refusing to guess a number"
  echo "T$((highest + 1))"
}

# Resolve a `Depends on: T<nn>` line to the issue that owns the number, pull requests excluded. More than
# one row means the number names two tickets; docs/ROUTINES.md has the table. No rows is a failure: a
# dependency that cannot be found is not a dependency that is closed.
cmd_depends() {
  [ $# -eq 1 ] || die "usage: gh-issues.sh depends T<nn>"
  local ticket="$1" rows found
  case "$ticket" in
    T[0-9]*) ;;
    [0-9]*) ticket="T$ticket" ;;
    *) die "depends: expected T<nn>, got $1" ;;
  esac
  rows="$(stable_pages "repos/$(repo)/issues?state=all&per_page=100")" || exit 3
  found="$(printf '%s' "$rows" | jq -r --arg t "$ticket" \
    '.[] | select(.pull_request == null) | select(.title | startswith($t + ":")) | "\(.number) \(.state) \(.title)"')"
  [ -n "$found" ] || die "no issue is titled \"$ticket: …\"; a dependency that cannot be found is not one that is closed"
  printf '%s\n' "$found"
}

command="${1:-}"
shift || true
case "$command" in
  list) cmd_list "$@" ;;
  pages) cmd_pages "$@" ;;
  next-number) cmd_next_number "$@" ;;
  depends) cmd_depends "$@" ;;
  *) die "usage: gh-issues.sh {list <query>|pages <query>|next-number|depends T<nn>}" ;;
esac
