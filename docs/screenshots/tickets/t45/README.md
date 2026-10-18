# T45 — clear the generated route types at the start of every check run

No screenshots. T45 changes one `rm -rf` in `scripts/agent-check.sh` and the paragraph in `docs/ROUTINES.md`
that tells both routines about it. No route, page, component, style or copy is touched, so there is no screen
to photograph and no screen that could have changed: `npm run e2e` renders exactly what it rendered before.

The evidence for this ticket is the typecheck step, not a PNG, and it is in the pull request body: the stale
route type reproduced (a `TS2307` on a page that is not in the working tree), the same typecheck passing with
only the new `rm -rf .next/types` in front of it, and the two build timings that decided the ticket's open
question — 63 seconds cold against 40 seconds with `.next/cache` kept, which is why the script clears
`.next/types` rather than all of `.next`.
