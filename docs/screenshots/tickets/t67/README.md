# T67 — the journey books a dated visit

From the `bash scripts/agent-check.sh` run of the tree this landed on. The run was on 2026-10-18, so the
appointment the spec books — three days out at 09:30 local — is **Wednesday, Oct 21, 9:30 AM**. Every shot
below used to read `Date pending` or `· no visit date` in the place the date is now.

| Shot | What to look for |
|---|---|
| `desktop-journey-03-add-visit.png` | §2.2's wizard, on the review step. The card reads the booking back as `Follow-up · Oct 21, 9:30 AM` — the date staff typed on the Visit step, before anything is written. |
| `desktop-journey-11-clinician-dashboard.png` | The clinician's dashboard. The Visit column reads `Wed, Oct 21` above `Follow-up · highs after dinner since the …`, which is the line the front desk schedules by (§4.4). |
| `desktop-journey-12-sour-brief.png` | §7.2's one-pager. The header under the patient's name is `Follow-up · Wednesday, Oct 21 · 7 days · 2,016 readings · Dexcom · WHOOP`, and the sidebar's summary card is dated `Oct 21 · 2 sources`. |
| `desktop-journey-14-dashboard-reviewed.png` | The same row after the sign-off (§7.3): the date stays put beside `Reviewed` and `by Dr. Journey Okafor`. |
| `desktop-journey-15-print-sheet.png` | §7.4's sheet. The same `Follow-up · Wednesday, Oct 21 · …` line, printed. The spec also asserts the `<time datetime>` behind it, which carries the instant rather than the reader's rendering of it. |
| `mobile-journey-12-sour-brief.png` | The brief at 375px (§6.5). The header wraps to two lines with the date intact and nothing scrolls sideways. |

A visit booked with no date is unchanged and still reads `Date pending`; `e2e/visits.spec.ts` is the wizard
run that leaves the field blank, and it now asserts that cell. Its own screenshot is the whole seeded
dashboard, which is one of the oversized full-page shots T81 is about, so it is not committed here.
