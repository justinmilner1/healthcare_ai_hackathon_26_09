# T31 screenshots

From `bash scripts/agent-check.sh` on branch `t31-startup-config-validation`.

This ticket adds no UI. What the screens are evidence of is that the §3.7 gate now runs before every server
in the suite answers a request, and that none of them is refused: both Playwright servers are production
builds (`NODE_ENV=production`), so the strict rules applied to all four screens below.

| File | What it shows |
|---|---|
| `desktop-provider-dashboard.png` | The practice dashboard on a server that booted through the gate. The invite links behind "Copy intake" and "Send link" now come from `appUrl()` in `lib/config.ts` rather than each call site's own `process.env.APP_URL ?? "http://localhost:3000"`; the flow test follows one, which is how the screen below was reached. |
| `desktop-sweetie-start.png` | No model key: the gate logged three warnings and the server started anyway, which is the point of the `recommended` level. "Demo mode" in the corner is the page saying the same thing. |
| `desktop-sweetie-degraded.png` | The second server, with a key set and an unreachable gateway. It boots too, and the §6.3 note is unaffected. |
| `desktop-patient-summary.png` | The patient's own page, unchanged. (The `follow_up` chip reading as an id rather than a label is issue #44, not this ticket.) |
| `desktop-provider-signin.png` | T05's sign-in page on a server that booted with `AUTH_SECRET` now `required`. This is the screen that stops existing when the variable is missing, which is why the row is `required` rather than `recommended`: Auth.js answers every request with a Configuration error and the deployment is up with nobody able to sign in. |

The part of this ticket with no screen is the refusal itself. A production build with `APP_URL` unset:

```
$ DATABASE_URL=postgresql://... npx next start
Refusing to start: 1 configuration problem.
  - APP_URL is not set. Public base URL of this deployment. Every patient and provider link is built from it.
See .env.example for every variable, or run `npm run config:check`.
$ echo $?
1
```

And the same list from `npm run config:check -- --production`, which exits 1 without starting anything:

```
3 problems that stop the app from starting:
  - DATABASE_URL must be a postgresql:// URL — this app is Postgres only (design §3.2).
  - APP_URL must use https:// in production — patient links carry a session token (design §10.1).
  - TWILIO_AUTH_TOKEN and TWILIO_FROM are required when TWILIO_ACCOUNT_SID is set (lib/sms.ts cannot send without them).

3 warnings:
  - OPENAI_BASE_URL is not set, so the SDK's own default is used, which is not Bedrock.
  - OPENAI_API_KEY is not set, so Sweetie and Sour answer from their scripted paths and the page says so (design §6.3, §11.3).
  - BEDROCK_OPENAI_MODEL_ID is not set, so lib/llm.ts falls back to openai.gpt-5.5, which may not be enabled for your account.
```

A deployment making the two mistakes T05 introduced, from `npm run config:check -- --production`:

```
2 problems that stop the app from starting:
  - AUTH_SECRET is lib/auth.ts's development constant, which is public in this repository — generate one with `openssl rand -base64 32`.
  - DEV_MAIL_DIR is set on a deployment serving a public APP_URL: every email, sign-in links included, would be written to a file on the server instead of sent (design §5.1, §10.6). Unset it, or point APP_URL at localhost if this is a local production build.
```

The same two values with `APP_URL=http://localhost:3100` — the e2e suite's own environment, two production
builds that divert their mail on purpose — produce no problems at all.

No value is ever printed: `DATABASE_URL` held a password in that run and `TWILIO_ACCOUNT_SID` a SID, and
neither appears above. `lib/config.test.ts` asserts it.
