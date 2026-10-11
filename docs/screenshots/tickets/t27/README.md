# T27 screenshots

From `bash scripts/agent-check.sh` on branch `t27-security-headers-csrf-audit`. Every one of these was taken
by `e2e/security.spec.ts` while asserting that no Content Security Policy violation reached the console, so
each is also the evidence that the screen hydrates under the nonce policy.

That is the point of the set. The nonce fails quietly: the scripts are refused, the shell renders, and the
page simply never fills in. It happened on this branch before the root layout forced dynamic rendering, and
every screen below shows data that only appears once its client JavaScript has run.

| File | What it shows |
|---|---|
| `desktop-security-provider-dashboard.png` | The clinician dashboard, filled in from two client fetches. Pixel-identical to the `t20` baseline: the policy changed no rendering. |
| `mobile-security-provider-dashboard.png` | The same at phone width. |
| `desktop-security-sweetie.png` | Sweetie's greeting, written by `GET /api/sweetie` after hydration. |
| `mobile-security-sweetie.png` | The same at 375px — progress card, data buttons, transcript and composer all intact. |
| `desktop-security-intake.png` | The intake Connect step, reached by clicking through from step 1. This is the screen whose Dexcom sandbox button is the one plain `<form>` in the app and the only caller that passes its CSRF token in the query string. The button is greyed because Dexcom is not configured in the sandbox, which is the pre-existing `!dexcomStatus.configured` state, not the new token check. |
| `mobile-security-intake.png` | The same at phone width: three source cards stacked, no horizontal scroll. |
| `desktop-security-patient-summary.png` | The patient's own summary page, past its loading card. |
| `mobile-security-patient-summary.png` | The same at phone width. |
| `desktop-security-landing.png` / `mobile-security-landing.png` | The landing page, which `next/font` and Tailwind style inline — the reason `style-src` keeps `'unsafe-inline'`. |
| `desktop-provider-sour.png` | The Sour pane from the unchanged `flows.spec.ts`, pixel-identical to the `t13` baseline. |
