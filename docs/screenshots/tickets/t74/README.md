# T74 — the env var a practice was told to set

`app/provider/dashboard.tsx` put `VisitDelivery.error` straight into the delivery pill's tooltip, so hovering
a red `Email ✕` beside a patient's name told a practice's front desk to set `EMAIL_FROM`, or
`RESEND_API_KEY`, or "AWS keys". §8.3 asks for the status and the provider's message id, which are theirs;
an environment variable is the deployment's and there is nothing a front desk can do with one.

A `title` is in the DOM and in no screenshot, which is how the string survived twenty reviewed tickets. So
the mapped reason is **also printed under the pill**, beside the two lines that were already there for the
same reason — §13.4's demo line and §8.1's suppression line — and that is what these PNGs show. It is not
only evidence: the dashboard is tested at 375px (§6.5), where there is no hover and so no tooltip at all.

Every shot is from the `bash scripts/agent-check.sh` run this ticket landed on (190 passed, exit 0, e2e
5m09s). The mobile ones are a screenful each with the Messages column scrolled into it (T57).

| File | What to look at |
|---|---|
| `desktop-provider-dashboard-demo-messages.png` | The two rows this is about, one above the other. **Demo Real Number** is §13.4 refusing to message a number that could be somebody's — amber, unchanged, and the model this ticket was asked to write in. **Demo Reserved Number** is the new line, in the failure red of the pill it sits under: *The text did not go out — ask whoever set Sweet Spot up for your office*. Before this ticket that row's tooltip read `sns: The security token included in the request is invalid.` |
| `mobile-provider-dashboard-demo-messages.png` | The same two rows at 375px. The sentence wraps to three lines inside the Messages column and nothing is clipped — and on this device the tooltip it replaces could never have been read at all. |
| `mobile-provider-dashboard-deliveries.png` | The control. Dana Demo's seeded row is untouched: `TEXT ✓`, `EMAIL ↩` and **Email bounced · Oct 17**, because §8.1 keeps a bounce's own words — "it came back" is a different statement from "it never went", and SES's subtype is what a support request quotes. Sam Sample's row below it is the other untouched case: `TEXT …`, `EMAIL …`, no sentence, because nothing has reported yet. |

What the tooltips now read, from the same run (`e2e/demo.spec.ts` and `e2e/notifications.spec.ts` assert
these; `getAttribute("title")` is how they are read):

| Pill | `title` |
|---|---|
| Demo Reserved Number, `TEXT ✕` | `The text did not go out — ask whoever set Sweet Spot up for your office` |
| Demo Real Number, `TEXT –` | `not sent: a demo practice only messages reserved test addresses (design §13.4)` |
| Dana Demo, `EMAIL ↩` | `Permanent/General · demo-ses-message-id` |

The third row is the §8.3 half of the ticket: the message id is still there, next to the reason, because a
support request to AWS quotes it.

`e2e/notifications.spec.ts` also reads the `title` of *every* delivery pill on the dashboard — not only the
seeded ones — and fails on anything variable-shaped. The rows the other specs book are the ones whose sends
really ran into this environment's missing senders, so that sweep is where a string written next year gets
caught.
