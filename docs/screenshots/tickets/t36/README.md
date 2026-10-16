# T36 — the documentation refresh

T36 changes no screen. The deliverable is three documents: `README.md`, `AGENTS.md` and
`docs/AGENT_ARCHITECTURE.md`. So these are not shots of something new.

The README's Flow section now claims, step by step, that the code follows design §2.1 to §2.8, and the
architecture document claims the work after the invite belongs to a visit and that Sour is a queued job.
Those are claims about screens, so each one below is the screen that carries it, read back from the
`bash scripts/agent-check.sh` run this pull request reports (178 passed). If a step of the documented flow
had no screen behind it, the document would be describing a product that does not exist.

| File | The claim it stands behind |
|---|---|
| `desktop-landing.png` | The first screen the README describes, and the two agents in the words the document uses: Sweetie gathers, Sour briefs. (The footer still signs itself "Healthcare AI Hackathon" — the last hackathon-only string left in the UI. It is code, so it belongs to T37, and it is noted on that issue rather than fixed here.) |
| `desktop-journey-01-practice-users.png` | **§2.1 Practice onboarding**, and three claims in one screen: the three roles with what each may do, the practice name patients see, and "kept for as long as the practice's retention setting says" — 365 days, in a field an admin owns. |
| `desktop-journey-03-add-visit.png` | **§2.2 Visit creation**, which the README's tour calls step 2: the patient, the visit type, what they called about ("highs after dinner since the new job"), the contact channel, and how the consent to be contacted was taken — recorded against the member of staff who saved it. |
| `desktop-journey-05-verify-code.png` | **§2.3 Invite**: the six-digit code screen the link opens into, which is why the README says a forwarded link alone reveals nothing. |
| `desktop-journey-06-consent.png` | **§2.4 Consent**, first open only: what is collected, that it is optional, that a clinician reads it, how to have it deleted, and the one tap that continues. |
| `desktop-journey-07-sweetie-greeting.png` | **§2.5 Sweetie**, and the correction this ticket makes to `AGENTS.md`: the intake template is two fields, not the old list of meals, unusual week, symptoms and visit goal. The stepper names them — *Why you're here*, *Since last visit*, *Done* — and the greeting asks the first one in the words of the booking reason, which is `fieldsFor(visitType, reason)` on screen. The optional data panel is beside it. ("the button on the left" is open bug T53.) |
| `desktop-journey-09-sweetie-complete.png` | The end of the same interview: both questions answered, the data shared, and the link to the patient's own summary. |
| `desktop-journey-11-clinician-dashboard.png` | Where the tour's step 4 waits: the visit's status, which the job moves to `summary_ready` rather than the request that asked for it. |
| `desktop-journey-12-sour-brief.png` | **§2.6 Sour**, and the architecture document's split: every number on this page — time in range, average, GMI, the five spikes, the sleep nights — is computed in `lib/sour.ts`, and only the two written parts come from the model. Here they say the gateway is not configured, which is the scripted mode the README describes and open bug T63 for its wording. |
| `desktop-provider-sour-stale.png` | "What the clinician sees while they wait is the job itself" (§7.1, §7.2): the chip, here saying the saved summary is out of date because a file arrived after it, with Regenerate beside it. This is the screen behind the idempotency paragraph the architecture document gained. |
| `desktop-journey-13-sour-reviewed.png` | §2.6's sign-off: who marked it reviewed and when, on the page itself. |
| `desktop-journey-15-print-sheet.png` | §7.4, the one-pager the tour's step 5 ends on: the summary alone, nothing of the application around it. |
| `desktop-journey-10-patient-summary.png` | **§2.7 The patient's own view**, behind the same verified link. (The raw `follow_up` pill is open bug T41 and the pattern text is T63; neither is a regression here.) |
