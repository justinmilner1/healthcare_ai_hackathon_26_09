# T09: Patient consent screen

From `scripts/agent-check.sh` (the Playwright run writes these to `e2e/screenshots/`). Design §2.4.

| Screenshot | What it shows |
|---|---|
| `desktop-consent.png`, `mobile-consent.png` | The screen a verified link opens on first open: what Sweetie collects, that it is optional, that a clinician reviews it, and how to have it deleted — then one tap. The clinician and the practice are named, so the patient knows who is being agreed with. The mobile shot is the one that matters (§6.5): the whole screen fits one column at 412px with no sideways scroll. |
| `desktop-consent-declined.png`, `mobile-consent-declined.png` | "No thanks". The session is revoked server-side before this renders, so it is the end of the visit's intake and not a soft dismissal: no second ask, no argument, and the way back is to open the link again. |
| `desktop-verify-done.png`, `mobile-verify-done.png` | What the tap opens — the chat, unchanged, now behind two gates instead of one. |
