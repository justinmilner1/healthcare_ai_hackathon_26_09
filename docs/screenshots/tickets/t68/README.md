# T68 — start the `/infra` check from an empty `cdk.out`

No screenshots. T68 changes `scripts/infra-check.sh` — one `rm -rf cdk.out` before the install, and a closing
line that reads `cdk.out/manifest.json` instead of listing `cdk.out/*.template.json` — plus the paragraph in
`docs/ROUTINES.md` that tells both routines about it. No route, page, component, style or copy is touched, so
there is no screen to photograph and none that could have changed: `npm run e2e` renders exactly what it
rendered before, and the PNGs this run wrote to `e2e/screenshots/` are the same screens as the run before it.

The evidence for this ticket is the `/infra` step's own output, and it is in the hand-off comment on issue
#111: the reproduction in both orders (a tree that builds `SweetSpot-staging` alone reports one template, the
tree that builds both reports two, whichever ran first), a planted
`cdk.out/SweetSpot-ghost.template.json` gone from both the directory and the line, the two failure paths
(an assembly with no stack, and a manifest naming a template that is not on disk) each exiting non-zero with
`infra-check: ...` rather than printing a verdict, and the timing that decided the `rm -rf` was free — about
seven seconds of synth either way, on a directory of about 420K.
