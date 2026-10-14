# T08: Patient link verification with one-time code

From `scripts/agent-check.sh` (the Playwright run writes these to `e2e/screenshots/`).

| Screenshot | What it shows |
|---|---|
| `desktop-verify-code.png`, `mobile-verify-code.png` | What a patient link opens now: the practice name, the channel the code went to, and nothing else. No patient name, no phone number, no address — a forwarded link reveals nothing (§2.3). |
| `desktop-verify-locked.png`, `mobile-verify-locked.png` | The third wrong try. The code is invalidated by that attempt rather than after it, so the screen says so and offers a new one instead of a fourth try that can only fail (§5.3). |
| `desktop-verify-done.png`, `mobile-verify-done.png` | The chat behind the gate, reached with the code read out of the console mailer. Until then the chat is not in the page at all: the gate is a server component. |
| `desktop-verify-no-contact.png` | A visit with no phone and no email on file. There is nowhere to send a code, so the screen says to call the office rather than showing a form that cannot work (§2.2). |
| `desktop-provider-dashboard.png` | The "New link" action (§5.5): a fresh token, every session and pending code on the old one dropped, and the new link sent. |
| `desktop-sweetie-start.png`, `desktop-patient-summary.png` | Both patient screens unchanged behind the gate — the same pages, now reached through a verified session. |
