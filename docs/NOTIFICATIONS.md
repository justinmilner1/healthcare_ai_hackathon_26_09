# Notifications

Design §8. Five messages, two channels, and one webhook that tells us what happened to them.

Everything in here is reached through `lib/notify.ts`. Nothing else in the app composes a message, and no
message carries clinical content — §8.2 is explicit about it: links only, and the summary itself never leaves
the site.

## The five templates (§8.2)

| Template | Where | Channels | What it carries |
|---|---|---|---|
| invite | `inviteTemplates` | sms, email | the practice, the patient's first name, the appointment date, the `/s/<token>` link |
| code | `codeTemplates` | sms, email | the six digits, how long they last, and that nobody from the office will ask for them |
| summary-ready (provider) | `summaryTemplates` | email | a link to `/provider/<id>?visit=<id>` |
| summary-ready (patient) | `summaryTemplates` | email | a link to `/patient/<token>` |
| deletion confirmation | `deletionTemplates` | sms, email | what was deleted, and that the practice keeps its own record |

Each template is a pure function, so `lib/notify.test.ts` reads the text and asserts what is *not* in it. The
sign-in and team-invite emails are §5.1 and §2.1 rather than §8, and live in `lib/mailer.ts`.

Who sends them: every one is a job (§3.4), so a send that fails is retried rather than lost, and nothing a
patient or a clinician is waiting for happens inside their request. `notify.invite`, `notify.code` and
`notify.summary` are in `lib/jobHandlers.ts`; the deletion confirmation goes out at the end of
`patient.delete`, after the purge, addressed from the contact details the purge is about to remove.

## Senders

| Channel | Production | Also supported | Unconfigured |
|---|---|---|---|
| email | SES (`lib/email.ts`), selected by `EMAIL_FROM` | Resend, for local use (§8.4), selected by `RESEND_API_KEY` | `{ sent: false }` with no provider, and the UI shows the link |
| sms | SNS / AWS End User Messaging (`lib/sms.ts`), selected by `SNS_ORIGINATION_NUMBER` | Twilio, for local use (§8.4), selected by `TWILIO_ACCOUNT_SID` | the same |

Two messages have nobody to fail soft to: a provider's sign-in link (§5.1) and a patient's verification code
(§2.3). There is no screen to read either of them off — they are the way in — so `DEV_MAIL_DIR` writes them
to the local mailbox instead (`lib/devMailbox.ts`, `npm run mail`), which is what makes both sign-ins walkable
offline and is how the e2e suite reads a link. See docs/ROUTINES.md.

That is an opt-in and not a fallback (T113). Naming the directory is the only thing that diverts mail; an
environment with neither it nor a backend sends nothing and says so, `{ sent: false }` with no provider, like
every other channel in the table. It used to divert on "no backend configured" as well, so a deployment that
had set §8.1 up for nothing wrote both credentials into `./.mail/` on its own disk and reported them sent —
§10.6's leftovers, under a success. A deployment with no email backend on a public `APP_URL` is now refused
by the §3.7 check (`lib/config.ts`), because neither sign-in works there; a patient whose only channel has no
sender behind it gets a screen that says so and names the practice to call, rather than a code screen
(`codeChannels` in `lib/notify.ts`, `components/VerifyGate.tsx`).

### Asked before the send, not only after it (T111)

Both columns of that table are answered by `smsConfig()` and `emailConfig()`, which resolve the backend and
its settings with no client built and no network call. So a screen does not have to wait for the job to find
out: `inviteSendability(channel)` in `lib/notify.ts` hands back the channels staff chose that have a backend
behind them, and — when that set is empty — the sentence `cannotSendYet` owns in `lib/delivery.ts`, the same
one the delivery row will carry minutes later.

`POST /api/book` and `POST /api/visits/import` both ask it, which is why `queued` on a booking response is a
claim about this deployment rather than about the `Job` table. The booking wizard used to read a queued row
as "the invite is on its way by email" in an office with no email backend at all, while the dashboard cell
for the same visit said email could not be sent. The jobs are still enqueued either way: they are what write
the `skipped` delivery rows the **Messages** column reads, so the dashboard does not fall silent about a
channel just because nothing could be sent on it.

What this does *not* predict is arrival. A configured backend can still bounce, and §8.1's suppression and
§13.4's demo rule close a channel on facts that live on the patient's row rather than in the environment.
Those are the delivery row's to report.

## Delivery results (§8.3)

A send writes a `VisitDelivery` row per message: `(visitId, kind, channel, audience)`, replaced by the next
send of that same message. The dashboard's **Messages** column prints them — the invite per channel, the
summary notice per audience — with the provider's message id and its own reason in the tooltip.

`status` is one of:

| status | means |
|---|---|
| `sent` | the backend accepted it |
| `failed` | a backend tried and refused |
| `skipped` | nothing tried: no address on file, no sender configured, or the channel is closed (below) |
| `bounced` | SES came back: the address is wrong |
| `complained` | SES came back: the recipient marked it as spam |

The last two arrive minutes after the send, through the webhook.

## Suppression (§8.1)

Two standing facts live on the `Patient` row, and `lib/suppression.ts` is the rule every send reads:

* `emailUndeliverableAt` / `emailUndeliverableReason` — a permanent bounce or a complaint. Transient bounces
  (a full mailbox, a greylist) are left alone: SES retries those itself and the address is not what is broken.
* `smsOptOutAt` — the patient texted STOP. AWS also keeps its own opt-out list and will drop what we publish;
  recording it here is what stops us spending the message and what staff see on the dashboard.

A closed channel is recorded as `skipped` with a reason, never `failed`, because `failed` is what the job
retries — and a retry to a dead address is the thing SES counts against the sending domain. A patient who
texts START reopens the channel.

The verification code is suppressed like everything else. A bounced address does not deliver a code either;
the honest answer is the other channel, or the staff member with the phone in their hand.

## Demo practices (§13.4)

A practice marked `isDemo` only ever messages a destination that cannot belong to anybody. The rule is an
allow-list in `lib/demo.ts`: an email address in a reserved domain (`.local`, `.test`, `.invalid`,
`.example`, `localhost`, or `example.com`/`.net`/`.org` and their subdomains — RFC 2606 and RFC 6761), or a
phone number in the NANP's fictitious `555-01xx` range. Everything else is not sent.

It is an allow-list rather than a block-list because of the mistake it exists to stop: a demo visit booked
against a prospect's own mobile number, and a stranger gets a text about an appointment they do not have.
Being wrong the other way costs a demo that says, on the dashboard, why a message did not go.

Mechanically it is the same shape as suppression above — `{ sent: false, error }` with **no** `provider`, so
the send is recorded `skipped`, is shown to staff with its reason, and is never retried. It is checked
*before* suppression, because it is the stronger statement: a bounce says this address does not work, and
this says we must not try it. Every one of the five templates goes through it, the verification code and the
clinician's summary notice included, and so does a team invite (`lib/mailer.ts`). The one message that does
not is a provider's own sign-in link: nobody sends that — it goes only to an address that has just asked for
it on the form, and gating it would lock a demo practice's admin out of their own practice.

The seeded practice is the demo practice (`npm run seed`, `lib/practice.ts`), and every address and number in
`scripts/seed.ts` is a reserved one, so the demo flow works end to end with the rule on.

## The webhook

`POST /api/notifications/sns` is the one door SES and SNS report through. Its whole authority is the signature
on the message, so three things are checked before a row is written (`lib/snsSignature.ts`):

1. the topic ARN is one of `SNS_TOPIC_ARNS`;
2. the signature verifies against a certificate fetched from an `sns.<region>.amazonaws.com` URL over https —
   the certificate URL arrives *inside* the message being verified, so without this an attacker signs their
   own body with their own key and points us at their own certificate;
3. the envelope's timestamp is within an hour, so a captured notification cannot be replayed.

Status codes are chosen for AWS, not a browser: a refusal is a 4xx so SNS stops retrying it, and a
notification we understood is a 200 even when it changed nothing (an address belonging to no patient here is
not a failure). With `SNS_TOPIC_ARNS` unset the route answers 503 and trusts nothing.

The route is in `CSRF_EXEMPT_PATHS` (lib/csrf.ts): it derives no authority from a cookie, so there is nothing
for a cross-site page to ride, and challenging it would make every bounce notification a 403.

## Setting it up in AWS

### Email: the domain, DKIM and the events topic

1. **Verify the sending domain.** SES → *Verified identities* → *Create identity* → Domain. Choose *Easy
   DKIM*, RSA 2048, and publish the three `CNAME` records SES gives you. Verification and DKIM both go green
   within minutes of the records propagating; until DKIM is green, mail is signed only by the domain's
   `MAIL FROM` and will land in spam.
2. **Publish `SPF` and `DMARC`.** A `TXT` record `v=spf1 include:amazonses.com ~all` on the custom MAIL FROM
   subdomain, and `_dmarc` as `v=DMARC1; p=none; rua=mailto:dmarc@<your domain>` to start. Tighten `p` once
   the reports are clean.
3. **Set `EMAIL_FROM`** to an address on that domain. SES rejects an unverified sender outright. This is also
   what tells the app to send through SES at all: a backend is chosen by the setting it cannot send without,
   and an AWS credential is not one (T110). `lib/email.ts` reports itself unconfigured until this is set — it
   never builds an SES client on the strength of an ambient `AWS_ACCESS_KEY_ID`, which is how the offline
   check run (§11.3) came to retry every invite against a sender it did not have. `EMAIL_PROVIDER=ses` forces
   the backend but does not stand in for the address; `npm run config:check` says so.
4. **Leave the sandbox.** SES → *Account dashboard* → *Request production access*. In the sandbox every
   *recipient* must be a verified identity too, which is fine for a demo and not for a practice.
5. **Create the events topic.** SNS → *Create topic* → Standard, e.g. `sweetspot-ses-events`.
6. **Create a configuration set** (SES → *Configuration sets*) with an *Event destination* of that SNS topic,
   publishing **Bounce**, **Complaint** and **Delivery**. Set `SES_CONFIGURATION_SET` to its name and
   `SNS_TOPIC_ARNS` to the topic ARN.
7. **Subscribe the webhook.** On the topic, *Create subscription* → protocol HTTPS → endpoint
   `https://<your APP_URL>/api/notifications/sns`. Leave *Enable raw message delivery* **off**: the signature
   is on the envelope, and raw delivery removes it. SNS immediately posts a `SubscriptionConfirmation`, the
   route fetches the `SubscribeURL` and the subscription goes to *Confirmed*. If it stays *Pending*, look for
   `sns_webhook_unverified` or `sns_webhook_wrong_topic` in the log: the `code` field says which check failed.

### SMS: the origination number and STOP

1. **Request a number.** AWS End User Messaging → *Phone numbers* → *Request originator*. A 10DLC long code
   or a toll-free number; both need registration, and US destinations will not deliver without one.
   Registration is where the practice's details and a sample message go, and it takes days, not minutes.
2. **Set `SNS_ORIGINATION_NUMBER`** to it in E.164 (`+15551234567`). This is also what tells the app to send
   through SNS at all: a backend is chosen by the setting it cannot send without, and an AWS credential is
   not one (T94). `lib/sms.ts` reports itself unconfigured until this is set — it never publishes on the
   strength of an ambient `AWS_ACCESS_KEY_ID`, which is how the offline check run (§11.3) came to make 14
   doomed SNS calls in one run. `SMS_PROVIDER=sns` forces the backend but does not stand in for the number;
   `npm run config:check` says so.
3. **Leave the SMS sandbox** (*Account settings* → production access). In the sandbox only verified
   destination numbers receive anything.
4. **Turn on two-way SMS** on the number, with the destination set to an SNS topic, and add that topic's ARN
   to `SNS_TOPIC_ARNS`. This is what delivers an inbound `STOP` to us. AWS answers the keyword itself and
   stops delivering to the number either way; the inbound message is how the dashboard gets to say so.
5. **Optional: SMS delivery logging** (SNS → *Text messaging preferences*) to the same topic. A number already
   on AWS's opt-out list shows up there, which is how we learn about a STOP sent to a message we never saw a
   reply to.

### Locally

Nothing above is needed. `DEV_MAIL_DIR` sends mail to the console mailer (`npm run mail`) — `.env.example`
sets it, and it is what a local checkout should keep — and SMS reports itself unconfigured, so the invite link
is shown on screen.
That holds on a machine with AWS credentials in its environment too, which is what makes
`scripts/agent-check.sh` reach no external service: both of the invite's channels are `skipped`, with no
backend named on either row and no attempt to retry.
`npm run send:test` sends one real message once keys are set. The webhook has nothing to listen to and
answers 503, which is the right answer for a machine that no topic is pointed at.

## Environment variables

See `.env.example` for the whole list; the ones this document is about:

```
EMAIL_FROM, EMAIL_PROVIDER, AWS_SES_REGION          # who email comes from
SNS_ORIGINATION_NUMBER, SMS_PROVIDER, AWS_SNS_REGION # who texts come from
SES_CONFIGURATION_SET                               # which SES config set publishes events
SNS_TOPIC_ARNS                                      # the topics POST /api/notifications/sns believes
```

`npm run config:check` prints every one of them with its requirement level, and
`npm run config:check -- --production` judges them by production rules (§3.7).
