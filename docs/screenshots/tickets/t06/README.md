# T06 screenshots

From `bash scripts/agent-check.sh` on branch `t06-practice-onboarding-roles`. Everything below is a real
session: each identity signed in through its own magic link, because `e2e/roles.spec.ts` stubs nothing.

The practice in the settings shots is one the suite creates and names, and the two addresses are generated
per run (`freshEmail` in `e2e/auth.ts`), which is why they look the way they do — two Playwright projects
share one database and one mailbox, so a fixed address would have them signing in as each other.

| File | What it shows |
|---|---|
| `desktop-provider-settings.png` | The new screen (§2.1, §5.2). The practice name and the retention window §10.4's sweep reads; the invite form with one line per role, so an admin picks on purpose rather than by name; and the users list, where the invited nurse reads **Invited** until their first link is redeemed and the admin reads **Signed in**. |
| `mobile-provider-settings.png` | The same at 375px. The two forms stack, and the users table stops being a table: its role select is its only control, so sideways scrolling would have hidden it behind an edge with nothing to say it was there. Each row is a card and the cells carry their headings back. |
| `desktop-provider-dashboard.png` | The admin's dashboard. `Settings` sits beside `Add patient`, and the visit list is the **practice's** now rather than one user's — a visit the receptionist booked is the doctor's to read (§5.2). |
| `mobile-provider-dashboard.png` | The same at 375px. |
| `desktop-provider-dashboard-staff.png` | The same dashboard signed in as the invited staff account. No `Settings`, no `Open in Sour` or `Summarize`, and the hero says why: summaries are a clinician's to read. `Add patient`, `Copy intake` and `Send link` stay, which is the half of §5.2 staff does have. Every one of those routes re-checks the role anyway — hiding a button is a courtesy, not a lock. |
| `mobile-provider-dashboard-staff.png` | The same at 375px. |
