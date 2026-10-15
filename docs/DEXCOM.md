# Dexcom

Design §9.2, §4.10, §10.1. One OAuth integration, two Dexcom environments, one variable between them.

Everything goes through `lib/dexcom.ts`. `lib/dexcomEnv.ts` turns `DEXCOM_ENV` into a host, a pair of client
credentials and an upload filename, and nothing else in the app reads a Dexcom URL.

## The switch

| `DEXCOM_ENV` | Host | What it answers with | Visits that may connect |
|---|---|---|---|
| `sandbox` (default) | `https://sandbox-api.dexcom.com` | synthetic readings for Dexcom's fixed test accounts | synthetic demo visits only (`Visit.isSandbox`, §13.4) |
| `production` | `https://api.dexcom.com` | a real person's glucose | real visits only |

Sandbox is the default, and stays the default in every environment until Dexcom approves the application.
The failure modes are not symmetric: a deployment that meant to be in production and is still in sandbox
imports nothing anybody will mistake for care data, while the reverse pulls a real person's glucose onto a
demo record. An unrecognised value is refused at boot (`lib/config.ts`) rather than resolved to either one.

That last column is the only behaviour the switch changes beyond the URL. `visitMatchesEnv` in
`lib/dexcom.ts` is one rule in both directions: invented readings may only land on an invented patient, and a
real account's readings only on a real one. `POST /api/dexcom/connect` refuses the mismatch with a 403, the
callback refuses it again (the environment may have changed between the two requests), and
`POST /api/dexcom/demo` — which creates a synthetic visit to hold sandbox readings — is sandbox-only.

Imports are filed under a filename per environment, `dexcom-sandbox.json` or `dexcom-production.json`
(`Upload.filename`, §4.6), so a synthetic import and a real one are never mistaken for each other in a list
of uploads or in the audit trail.

## Variables

```
DEXCOM_ENV                       sandbox | production. Unset is sandbox.
DEXCOM_CLIENT_ID                 the application's credentials, for whichever environment has no pair below
DEXCOM_CLIENT_SECRET
DEXCOM_SANDBOX_CLIENT_ID         optional: the sandbox application, when a deployment holds both
DEXCOM_SANDBOX_CLIENT_SECRET
DEXCOM_PRODUCTION_CLIENT_ID      optional: the production application, when a deployment holds both
DEXCOM_PRODUCTION_CLIENT_SECRET
DEXCOM_REDIRECT_URI              this deployment's /api/dexcom/callback, registered with Dexcom
DEXCOM_TOKEN_KMS_KEY_ID          KMS key the stored refresh tokens are encrypted with (§4.10, §10.1)
DEXCOM_BASE_URL                  legacy; if set it has to agree with DEXCOM_ENV
```

Sandbox and production are separate applications on Dexcom's side, so they have separate credentials as well
as separate hosts. The prefixed names let one deployment hold both, which is what makes the move to
production a single variable and a restart. A deployment with one application sets the unprefixed pair and
nothing else, exactly as before the switch existed.

The group is optional as a whole — uploads work without any of it — but a partial set is not a lighter
version of it: `dexcomConfig()` throws on one, which the UI reads as "not connected" and which hides the typo
that caused it. `npm run config:check -- --production` reports the whole group, including a
`DEXCOM_BASE_URL` that contradicts the switch.

`DEXCOM_REDIRECT_URI` may be `http://localhost:3000/api/dexcom/callback` while developing against synthetic
data. Production refuses anything but `https://` (§10.1).

## Tokens at rest (§4.10, §10.1)

`DexcomConnection.encryptedTokens` holds a refresh token — a standing key to a patient's glucose history,
longer lived than any session in this app and not revocable from here. Two key sources, picked by whether
`DEXCOM_TOKEN_KMS_KEY_ID` is set, the way `lib/storage.ts` picks a backend:

| Source | When | How |
|---|---|---|
| `kms` | a key is configured | KMS encrypts the JSON itself. A few hundred bytes, far inside KMS's 4 KB limit, so there is no data key to wrap and nothing on the host that can decrypt on its own. Every use of the key is a CloudTrail record. |
| `local` | no key | a key derived from the client secret, for development and the demo. |

Either way the patient id is authenticated as additional data — the KMS encryption context, GCM's AAD
locally — so a ciphertext lifted from one patient's row into another's fails to decrypt instead of handing
back a working token for the wrong person. The stored string names its own key source (`kms.…`, `local.…`),
so a deployment moving from one to the other can tell what it is holding.

**A deployment with Dexcom configured must set the key.** `lib/config.ts` refuses to start without it, on the
same test the `DEV_MAIL_DIR` rule uses: `NODE_ENV=production` and an `APP_URL` someone else can reach. A
production build on a laptop (the e2e suite, `npm run build && npm start`) is not a deployment and is left
alone.

Making the key, once per environment:

```bash
aws kms create-key --description 'Sweet Spot Dexcom refresh tokens' --key-usage ENCRYPT_DECRYPT
aws kms create-alias --alias-name alias/sweetspot-dexcom-tokens --target-key-id <key-id>
```

The task role needs `kms:Encrypt` on it to store a token and `kms:Decrypt` to use one; granting only the
first is a deployment that can connect a patient and cannot read back what it stored. An ARN names its own
region, so there is no region variable; an id or alias uses the default region. Rotating the key, or moving
from the local key to KMS, means every patient reconnects — there is no re-encryption pass, and the recovery
has always been a reconnection.

## Applying for production access

Dexcom opens production per application, on their review, and until it comes through nothing in this
repository needs to change: §9.2 says the approval application "is a ticket but does not block anything".

1. In the Dexcom developer portal (`developer.dexcom.com`), the sandbox application is the one already in
   use. Production is a separate application, created in the same place.
2. Register the production redirect URI — the deployment's `https://…/api/dexcom/callback`, which has to be
   the exact string in `DEXCOM_REDIRECT_URI`. Dexcom matches it literally.
3. Request the scope the import uses, `offline_access`, and no other. `lib/dexcom.ts` asks for that one and
   reads `/v3/users/self/dataRange` and `/v3/users/self/egvs` with it.
4. Dexcom's review asks what the data is for, who sees it, and how it is stored and deleted. The answers are
   in this repository: §10.1 for encryption at rest and in transit, §10.2 for the audit trail, §10.4 and
   §10.5 for retention and deletion, and the BAA list in `docs/COMPLIANCE.md` (T34) — Dexcom is on it.
5. A Dexcom BAA is needed before real patient data moves, alongside the AWS one (§10.7).

When the production application is approved:

1. Put its credentials in SSM Parameter Store as `DEXCOM_PRODUCTION_CLIENT_ID` and
   `DEXCOM_PRODUCTION_CLIENT_SECRET` (§10.6). Leave the sandbox pair where it is.
2. Create the KMS key above and set `DEXCOM_TOKEN_KMS_KEY_ID`, if the environment does not have one yet.
3. Set `DEXCOM_ENV=production` and redeploy. `DEXCOM_BASE_URL`, if the environment still sets it, has to be
   unset or changed to match, or the deployment refuses to start — deliberately, because an operator who
   pinned the old variable believes they are in the environment they named.
4. Check `npm run config:check -- --production` against the deployed environment, then connect one real
   account and confirm the import lands as `dexcom-production.json` on a real visit.

Staging stays on the sandbox. There is nothing in a staging environment that should be able to reach a real
person's glucose, and the demo practice (§13.4) is synthetic by definition.

## Not in scope

Dexcom's push notifications, a token refresh loop, and importing anything but EGVs. `decryptTokens` in
`lib/dexcom.ts` is the half the refresh path will need; nothing calls it yet, because a connection imports
once, inside the callback, with the access token still in hand.
