// Which issues a pull request body says it closes (T55). Owner: ops.
//
// `.github/workflows/auto-merge.yml` closes the linked issue itself rather than leaving it to GitHub's
// implicit pull-request-body linking, which silently did nothing twice (#66 and #10 stayed open and labeled
// `review` after their pull requests merged, and the builder's selection rule in `docs/ROUTINES.md` never
// looks at `review`, so both tickets were stranded). The cause could not be established from the sandbox:
// what a pull request will close lives in `closingIssuesReferences`, which is GraphQL only and blocked here —
// itself a reason not to depend on it.
//
// The workflow runs `actions/github-script` with no checkout, so it cannot import this module; it carries the
// same regex inline. `closingIssues.test.ts` reads the workflow and fails if the two drift apart, so this
// file stays the one place the keyword list is written down and reasoned about.

// Fenced blocks and inline code spans are quoted examples, not links. A pull request body that explains
// this very workflow writes "`Closes: #12`" to show the colon form, and #139's body did: taken literally it
// would have closed #12, a ticket the pull request has nothing to do with. Blanked before matching, so a
// keyword only counts where it is actually a sentence about this pull request.
export const CODE_SPAN_PATTERN = "```[\\s\\S]*?```|`[^`\\n]*`";

// GitHub's own closing keywords, case-insensitively, with the optional colon GitHub also accepts
// ("Closes: #12"). Only bare `#<n>` in this repository: a cross-repository `owner/repo#n` reference is
// somebody else's issue and is not ours to close, so the leading boundary rejects it.
export const CLOSING_KEYWORD_PATTERN = "(?:^|[^\\w/-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#(\\d+)";

/** The issue numbers a pull request body names with a closing keyword, in order, without duplicates. */
export function parseClosingIssues(body: string | null | undefined): number[] {
  const prose = (body ?? "").replace(new RegExp(CODE_SPAN_PATTERN, "g"), " ");
  const found: number[] = [];
  for (const m of prose.matchAll(new RegExp(CLOSING_KEYWORD_PATTERN, "gi"))) {
    const n = Number(m[1]);
    if (n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
}
