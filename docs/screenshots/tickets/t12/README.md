# T12 screenshots

From `bash scripts/agent-check.sh` on branch `t12-audit-log`. Every row in these shots was produced by doing
the thing, not by writing a row: `e2e/audit.spec.ts` books a visit as the signed-in admin, opens the patient's
own link to upload a Dexcom export, reads the visit back as the clinician, and then deletes the upload over
the same link. The other specs in the run share the practice, so the unfiltered page shows their rows too.

The ids are cuids from a throwaway database and the patient details are the suite's own (`Audit Patient`,
`Sam Sample`) — which is the point of the last assertions in that spec: neither appears anywhere in these
tables, or in the CSV the Export button hands over.

| File | What it shows |
|---|---|
| `desktop-provider-audit.png` | The new screen (§4.8, §10.2). Filters across the top — action, who, a visit or upload id, a date range, how many — then the trail, newest first. A row is a time, a person, what they did, the thing they did it to and a detail with no patient in it. `count: 2` on a link row is two uses of one invite link inside the coalescing window; `part: uploads` is the one part of the visit the bundle actually carried. |
| `mobile-provider-audit.png` | The same at phone width, viewport only. The filters stack and the table stops being a table: each row becomes a labelled card, the way the users table does in settings. `Settings` drops out of the header, because the phone hides the first button in that row and the way back to the dashboard is what matters there. |
| `desktop-provider-audit-visit.png` | Filtered to the one visit the spec created: the link accepted, the clinician's read of the uploads, and the patient's deletion. Three rows, and the heading changes to say the list is a filtered one. |
| `mobile-provider-audit-visit.png` | The same three rows stacked. |
| `desktop-provider-dashboard.png` | `Audit` beside `Settings` in the admin's header. Both are admin-only and both are hidden for a clinician or a receptionist — `e2e/roles.spec.ts` checks that the link is absent *and* that the page and the route refuse them. |
| `mobile-provider-dashboard.png` | The same at phone width. |
| `desktop-provider-settings.png` | The admin's other screen, now linking to the audit trail. |
| `mobile-provider-settings.png` | The same at phone width. |
