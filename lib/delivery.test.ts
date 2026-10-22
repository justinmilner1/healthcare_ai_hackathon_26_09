// Unit tests for what a delivery row says to staff (T74, design §8.3, §8.1).
//
// The half worth reading first is `names nothing a practice cannot act on`: it calls the real senders with
// nothing configured and with a half-configured SES, so the two strings this ticket was filed about are the
// test's input rather than a copy of them, and a third sender written in lib/email.ts or lib/sms.ts tomorrow
// is mapped by this module's default rather than appearing on the dashboard unseen.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cannotSendYet,
  DELIVERY_NOT_CHOSEN,
  DELIVERY_NO_EMAIL,
  DELIVERY_NO_PHONE,
  deliveryFault,
  deliveryFaults,
  deliveryReason,
  deliveryTooltip,
  NO_CODE_CAN_REACH,
  NO_CONSENT_TO_MESSAGE,
  type DeliveryFacts,
} from "./delivery";
import { DEMO_BLOCKED } from "./demo";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { SUPPRESSED_REASONS, suppressedReason } from "./suppression";

/** Each backend is selected by the setting it cannot send without — EMAIL_FROM for SES (lib/email.ts, T110),
 *  an origination number for SNS (lib/sms.ts, T94) — and a sandbox carries AWS credentials besides, so the
 *  senders below are called with the environment emptied of every one: these tests are about the text a
 *  refusal carries, not about the network's opinion of it. */
const SENDER_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "SMS_PROVIDER",
  "SNS_ORIGINATION_NUMBER",
];

async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(SENDER_KEYS.map((k) => [k, process.env[k]]));
  for (const key of SENDER_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(over)) if (value !== undefined) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const row = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  channel: "email",
  status: "failed",
  error: null,
  providerName: null,
  providerMessageId: null,
  ...over,
});

/** What must never reach a practice's screen: a variable name, a credential, a vendor's console. */
const CONFIGURATION = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|RESEND|TWILIO|\bSES\b|\bSNS\b|\bAWS\b|api[ _-]?key|credential|verified identity/i;

describe("a reason written for staff passes through (§8.3)", () => {
  it("keeps lib/notify.ts's own refusals", () => {
    for (const error of [DELIVERY_NOT_CHOSEN, DELIVERY_NO_PHONE, DELIVERY_NO_EMAIL, "provider has no email", "patient has no email"]) {
      assert.equal(deliveryFault(row({ status: "skipped", error })), null, error);
      assert.equal(deliveryReason(row({ status: "skipped", error })), error);
    }
  });

  it("keeps §8.1's suppression and §13.4's demo rule, from the modules that own them", () => {
    const stop = suppressedReason({ smsOptOutAt: new Date() }, "sms");
    assert.ok(stop, "the rule still produces a reason");
    assert.equal(deliveryReason(row({ channel: "sms", status: "skipped", error: stop })), stop);
    for (const error of SUPPRESSED_REASONS) assert.equal(deliveryFault(row({ status: "skipped", error })), null, error);
    assert.equal(deliveryReason(row({ status: "skipped", error: DEMO_BLOCKED })), DEMO_BLOCKED);
  });

  it("keeps a bounce and a complaint in the provider's own words (§8.1)", () => {
    // These are the one case where a backend's text belongs on the screen: the message left, and
    // "Permanent/General" is SES's phrase for what came back. A support request quotes it with the id.
    for (const status of ["bounced", "complained"]) {
      const d = row({ status, error: "Permanent/General", providerName: "ses", providerMessageId: "m-1" });
      assert.equal(deliveryFault(d), null);
      assert.equal(deliveryTooltip(d), "Permanent/General · m-1");
    }
  });

  it("says nothing when the row has no reason", () => {
    assert.equal(deliveryReason(row({ status: "sent", error: null })), undefined);
    assert.equal(deliveryReason(row({ status: "sent", error: "   " })), undefined);
    assert.equal(deliveryTooltip(row({ status: "sent", error: null })), undefined);
    assert.equal(deliveryTooltip(undefined), undefined);
    // §8.3 asks for the message id, so a send with nothing wrong with it still has a tooltip.
    assert.equal(deliveryTooltip(row({ status: "sent", error: null, providerName: "ses", providerMessageId: "m-2" })), "m-2");
  });
});

describe("a backend's own message is mapped at the edge (T74)", () => {
  it("names nothing a practice cannot act on", async () => {
    // The two strings this ticket was filed about, taken from the senders themselves rather than copied.
    const unconfigured = await withEnv({}, () => sendEmail("a@b.test", "s", "t"));
    const halfConfigured = await withEnv({ EMAIL_PROVIDER: "ses", AWS_ACCESS_KEY_ID: "not-a-real-key" }, () => sendEmail("a@b.test", "s", "t"));
    const noSms = await withEnv({}, () => sendSms("+14155550100", "t"));
    const halfTwilio = await withEnv({ TWILIO_ACCOUNT_SID: "AC-not-real" }, () => sendSms("+14155550100", "t"));

    assert.match(unconfigured.error ?? "", CONFIGURATION, "the sender's own text is the diagnostic, and keeps it");
    assert.match(halfConfigured.error ?? "", /EMAIL_FROM/, "the SES branch is still the one the issue quotes");

    for (const [channel, sent] of [
      ["email", unconfigured],
      ["email", halfConfigured],
      ["sms", noSms],
      ["sms", halfTwilio],
    ] as const) {
      const d = row({ channel, status: sent.provider ? "failed" : "skipped", error: sent.error ?? null, providerName: sent.provider ?? null });
      const reason = deliveryReason(d);
      assert.ok(reason, `${channel}: there is still something to say`);
      assert.doesNotMatch(reason, CONFIGURATION, `${channel}: ${reason}`);
      assert.equal(deliveryFault(d), reason, "the mapped line is the fault line too");
    }
  });

  it("gives a configuration gap the 'cannot send yet' line, from the senders themselves (T110, T94)", async () => {
    // The pair the two tickets are about, both taken from the real senders rather than written here: an
    // environment with nothing configured, and one with a credential and an explicit backend but not the
    // setting that backend needs. Neither reached anything, so neither is "did not go out" — which is the
    // sentence staff were being given for the invite on every run of the gate.
    const cases = [
      ["email", await withEnv({}, () => sendEmail("a@b.test", "s", "t"))],
      ["email", await withEnv({ EMAIL_PROVIDER: "ses", AWS_ACCESS_KEY_ID: "not-a-real-key" }, () => sendEmail("a@b.test", "s", "t"))],
      ["sms", await withEnv({}, () => sendSms("+14155550100", "t"))],
      ["sms", await withEnv({ SMS_PROVIDER: "sns", AWS_ACCESS_KEY_ID: "not-a-real-key" }, () => sendSms("+14155550100", "t"))],
    ] as const;
    for (const [channel, sent] of cases) {
      assert.equal(sent.provider, undefined, `${channel}: ${sent.error}`);
      const d = row({ channel, status: sent.provider ? "failed" : "skipped", error: sent.error ?? null, providerName: sent.provider ?? null });
      assert.match(deliveryFault(d) ?? "", channel === "email" ? /cannot send email yet/ : /cannot send texts yet/);
    }
    // And a backend that really was reached still gets the other sentence, so the pair stays a pair.
    assert.match(deliveryFault(row({ channel: "email", status: "failed", error: "Throttling: rate exceeded", providerName: "ses" })) ?? "", /The email did not go out/);
  });

  it("tells a sender that refused from no sender at all, on the field and not on the words", () => {
    // `providerName` is the same field statusOf in lib/visitStore.ts reads: a backend named on the row means
    // one was reached, none means there was nothing to reach. So the wording of a future sender's error
    // cannot change which sentence staff get.
    const refused = deliveryFault(row({ channel: "email", status: "failed", error: "Throttling: Maximum sending rate exceeded", providerName: "ses" }));
    const nothing = deliveryFault(row({ channel: "email", status: "skipped", error: "something new nobody has read yet", providerName: null }));
    assert.match(refused ?? "", /did not go out/);
    assert.match(nothing ?? "", /cannot send email yet/);
    assert.notEqual(refused, nothing);
    for (const text of [refused, nothing]) assert.doesNotMatch(text ?? "", CONFIGURATION);
  });

  it("says text for a text and email for an email", () => {
    const sms = deliveryFault(row({ channel: "sms", status: "failed", error: "sns: The security token included in the request is invalid.", providerName: "sns" }));
    assert.match(sms ?? "", /The text did not go out/);
    assert.doesNotMatch(sms ?? "", /email/i);
    const other = deliveryFault(row({ channel: "fax", status: "failed", error: "whatever a fax backend says", providerName: "fax" }));
    assert.match(other ?? "", /The message did not go out/);
  });

  it("keeps the message id beside the mapped reason (§8.3)", () => {
    const d = row({ status: "failed", error: "EMAIL_FROM must be a verified SES identity", providerName: "ses", providerMessageId: "m-3" });
    const tooltip = deliveryTooltip(d);
    assert.equal(tooltip, `${deliveryFault(d)} · m-3`);
    assert.doesNotMatch(tooltip ?? "", CONFIGURATION);
  });

  it("is one line per distinct fault across a visit's deliveries", () => {
    const faults = deliveryFaults([
      row({ channel: "email", status: "failed", error: "EMAIL_FROM must be a verified SES identity", providerName: "ses" }),
      row({ channel: "sms", status: "failed", error: "sns: The security token included in the request is invalid.", providerName: "sns" }),
      // Same fault, second message: the summary notice ran into the identical wall as the invite.
      row({ channel: "email", status: "failed", error: "EMAIL_FROM must be a verified SES identity", providerName: "ses" }),
      // Nothing to say about either of these.
      row({ channel: "sms", status: "sent", error: null, providerName: "sns", providerMessageId: "m-4" }),
      row({ channel: "email", status: "skipped", error: DELIVERY_NOT_CHOSEN }),
    ]);
    assert.equal(faults.length, 2, faults.join(" / "));
    assert.match(faults[0], /The email did not go out/);
    assert.match(faults[1], /The text did not go out/);
  });

  it("is short enough to sit under a pill in a table cell", () => {
    for (const channel of ["email", "sms"]) {
      for (const providerName of [null, "ses"]) {
        const text = deliveryFault(row({ channel, status: "failed", error: "x", providerName })) ?? "";
        assert.ok(text.length < 80, `${text.length}: ${text}`);
        // T96: it names whoever runs the deployment, never a practice role and never a control that does
        // not exist. The practice administrator's settings page has two fields and neither is a sender.
        assert.doesNotMatch(text, /administrator|admin\b/i, text);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T111 The same sentence, asked for before a send instead of after one. The booking wizard is told at the
// point of booking, and what it is told has to be the line the delivery row will carry minutes later —
// otherwise one visit has two stories, which is the bug the ticket was filed for.

describe("the line a screen gets before the send (T111)", () => {
  it("is the same sentence the delivery row carries for a channel with no backend", () => {
    for (const channel of ["email", "sms"]) {
      // Left-hand side: nothing was reached, because there was nothing to reach — a row with no
      // `providerName` (lib/visitStore.ts `statusOf` writes `skipped` for exactly that).
      const onTheRow = deliveryFault({ channel, status: "skipped", error: "SMS not configured: whatever the sender said" });
      assert.equal(cannotSendYet(channel), onTheRow, channel);
    }
  });

  it("names no channel for a visit booked on both, because neither of the two can send", () => {
    assert.match(cannotSendYet("both"), /cannot send this message yet/);
    assert.notEqual(cannotSendYet("both"), cannotSendYet("email"));
  });

  it("names nothing a practice cannot act on, for every channel", () => {
    for (const channel of ["email", "sms", "both", "", "carrier-pigeon"]) {
      const text = cannotSendYet(channel);
      assert.match(text, /^Sweet Spot cannot send/, text);
      assert.doesNotMatch(text, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, text);
      assert.doesNotMatch(text, /administrator|admin\b/i, text);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T120 The other sentence a screen gets before a send, and the one thing that must stay true of it: it is
// not the one above. `POST /api/book` and `POST /api/invite` both choose between the two, so a practice that
// told us not to contact this patient never reads that somebody should go and configure a sender.

describe("the line for a practice that chose to message nobody (T120)", () => {
  it("is not the deployment's gap, for any channel", () => {
    for (const channel of ["email", "sms", "both", "", "none"]) {
      assert.notEqual(NO_CONSENT_TO_MESSAGE, cannotSendYet(channel), channel);
    }
    assert.doesNotMatch(NO_CONSENT_TO_MESSAGE, /Sweet Spot cannot send|ask whoever set/);
  });

  it("names nothing a practice cannot act on either", () => {
    assert.doesNotMatch(NO_CONSENT_TO_MESSAGE, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
    assert.doesNotMatch(NO_CONSENT_TO_MESSAGE, /administrator|admin\b/i);
    // It reads as the tail of "No invite sent: ..." on both screens that say it, so it is a phrase and not
    // a sentence of its own: no leading capital and no full stop to double the one the screens add.
    assert.doesNotMatch(NO_CONSENT_TO_MESSAGE, /^[A-Z]|[.]$/);
  });

  it("says consent, which is the thing staff would change", () => {
    assert.match(NO_CONSENT_TO_MESSAGE, /consent/i);
  });
});

// ---------------------------------------------------------------------------------------------
// T121 (§2.3, §5.3) The line about a visit whose patient cannot be sent the code their link needs. It is
// the only sentence in this module that is a consequence rather than a reason: the three "why" lines are
// already on the row, and what none of them said is that the patient cannot get in at all.

describe("the line for a visit no code can reach (T121)", () => {
  it("is not any of the three reasons it follows", () => {
    // The row carries whichever of these closed its channels; this says what they add up to, so a reviewer
    // reading the cell gets the conclusion once and not a fourth explanation.
    for (const channel of ["email", "sms", "both", "", "none"]) {
      assert.notEqual(NO_CODE_CAN_REACH, cannotSendYet(channel), channel);
    }
    for (const reason of [...SUPPRESSED_REASONS, DEMO_BLOCKED, NO_CONSENT_TO_MESSAGE]) {
      assert.notEqual(NO_CODE_CAN_REACH, reason, reason);
    }
    assert.doesNotMatch(NO_CODE_CAN_REACH, /ask whoever set|bounced|STOP|spam|demo practice/i);
  });

  it("names nothing a practice cannot act on", () => {
    assert.doesNotMatch(NO_CODE_CAN_REACH, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
    assert.doesNotMatch(NO_CODE_CAN_REACH, /administrator|admin\b/i);
  });

  it("says the consequence and the one thing staff can do about it", () => {
    // §2.3 makes the code the only way into a patient link, so the visit stops here unless the front desk
    // picks up the telephone. Both halves are in the sentence because either on its own is half the news.
    assert.match(NO_CODE_CAN_REACH, /link will not open/i);
    assert.match(NO_CODE_CAN_REACH, /call them/i);
    // A sentence of its own, unlike NO_CONSENT_TO_MESSAGE above: it is printed on its own line in the
    // dashboard's Messages cell rather than as the tail of one the screen writes.
    assert.match(NO_CODE_CAN_REACH, /^[A-Z]/);
  });
});
