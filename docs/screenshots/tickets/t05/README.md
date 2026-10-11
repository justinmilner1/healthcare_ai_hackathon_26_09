# T05 screenshots

From `bash scripts/agent-check.sh` on branch `t05-authjs-magic-links`.

| File | What it shows |
|---|---|
| `desktop-provider-signin.png` | The new sign-in screen (§5.1). One field, no password, and the only way into the workspace: `/provider` redirects here when there is no session. |
| `mobile-provider-signin.png` | The same at 375px. The art stacks above the form, the field and button are full width, and nothing scrolls sideways. |
| `desktop-provider-check-email.png` | Where asking for a link lands. The local-mailbox note only appears on a server that is not sending mail, which is what tells a developer to run `npm run mail`. |
| `mobile-provider-check-email.png` | The same at 375px. |
| `desktop-provider-signout.png` | The sign-out screen, with the signed-in address and a button, because a GET must never end a session. |
| `mobile-provider-signout.png` | The same at 375px; the actions stack with the button first. |
| `desktop-provider-dashboard.png` | The dashboard after signing in with the emailed link. The practice picker is gone — there is nothing to pick, the session says who this is — and `Sign out` sits beside `Add patient`. |
| `desktop-provider-sour.png` | The Sour view behind the same session guard, still reading its provider and practice from `GET /api/provider`. |
