// Unit tests for reading what SES and SNS send us (§8.1), against the payload shapes in AWS's own
// documentation. The point of the module being pure is that these can be the real shapes: the bounce below
// is SES's documented example with the addresses changed, not a shape invented to match the parser.
//
// The two checks to read first are the security ones. `isSnsCertUrl` is what stops the certificate URL inside
// a request pointing the verifier at a certificate the sender controls, and `snsSigningString` is the exact
// text AWS signed — get a field or an order wrong and every real notification is refused, which is §8.1
// failing silently in the only direction that looks like nothing is happening.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedTopic,
  isSnsCertUrl,
  isSnsSubscribeUrl,
  notificationEvents,
  parseSnsEnvelope,
  parseTopicArns,
  snsSigningString,
  type SnsEnvelope,
} from "./snsEvents";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:sweetspot-ses-events";

const envelope = (over: Record<string, unknown> = {}) => ({
  Type: "Notification",
  MessageId: "22b480bf-3f2b-5b0c-a0a1-9d4f1f8d0b3a",
  TopicArn: TOPIC,
  Message: '{"notificationType":"Delivery"}',
  Timestamp: "2026-10-15T09:00:00.000Z",
  SignatureVersion: "2",
  Signature: "c2lnbmF0dXJl",
  SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
  ...over,
});

describe("parseSnsEnvelope", () => {
  it("reads a notification", () => {
    const e = parseSnsEnvelope(envelope())!;
    assert.equal(e.type, "Notification");
    assert.equal(e.topicArn, TOPIC);
    assert.equal(e.subject, null);
    assert.equal(e.signatureVersion, "2");
  });

  it("reads a subscription confirmation with its URL and token", () => {
    const e = parseSnsEnvelope(
      envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription", Token: "tok" }),
    )!;
    assert.equal(e.type, "SubscriptionConfirmation");
    assert.equal(e.token, "tok");
  });

  it("defaults the signature version to 1, which is what an older topic sends", () => {
    const raw = envelope();
    delete (raw as Record<string, unknown>).SignatureVersion;
    assert.equal(parseSnsEnvelope(raw)!.signatureVersion, "1");
  });

  it("keeps an empty Message, which a confirmation legitimately has", () => {
    assert.equal(parseSnsEnvelope(envelope({ Message: "" }))!.message, "");
  });

  it("is null for anything that is not an SNS envelope", () => {
    for (const body of [null, undefined, "a string", [], {}, envelope({ Type: "Something" })]) {
      assert.equal(parseSnsEnvelope(body), null, JSON.stringify(body));
    }
  });

  it("is null when a signed field is missing, because there would be nothing to verify", () => {
    for (const field of ["MessageId", "TopicArn", "Timestamp", "Signature", "SigningCertURL"]) {
      const raw = envelope();
      delete (raw as Record<string, unknown>)[field];
      assert.equal(parseSnsEnvelope(raw), null, field);
    }
  });
});

describe("snsSigningString", () => {
  const base = parseSnsEnvelope(envelope())! as SnsEnvelope;

  it("is the documented field order for a notification, with no Subject when there is none", () => {
    assert.equal(
      snsSigningString(base),
      `Message\n${base.message}\nMessageId\n${base.messageId}\nTimestamp\n${base.timestamp}\nTopicArn\n${base.topicArn}\nType\nNotification\n`,
    );
  });

  it("includes Subject only when the message has one", () => {
    const withSubject = parseSnsEnvelope(envelope({ Subject: "Amazon SES Email Event Notification" }))!;
    assert.match(snsSigningString(withSubject), /MessageId\n[^\n]+\nSubject\nAmazon SES Email Event Notification\nTimestamp/);
  });

  it("signs SubscribeURL and Token on a confirmation", () => {
    const confirm = parseSnsEnvelope(
      envelope({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?x=1", Token: "tok" }),
    )!;
    const text = snsSigningString(confirm);
    assert.match(text, /SubscribeURL\nhttps:\/\/sns\.us-east-1\.amazonaws\.com\/\?x=1\n/);
    assert.match(text, /Token\ntok\n/);
    assert.doesNotMatch(text, /Subject/);
  });
});

describe("the two URL checks", () => {
  it("accepts the SNS certificate hosts and nothing else", () => {
    assert.ok(isSnsCertUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem"));
    assert.ok(isSnsCertUrl("https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-x.pem"));
    for (const bad of [
      "http://sns.us-east-1.amazonaws.com/x.pem", // not https
      "https://sns.us-east-1.amazonaws.com.evil.test/x.pem", // the host that looks right
      "https://evil.test/sns.us-east-1.amazonaws.com/x.pem", // the path that looks right
      "https://sns.us-east-1.amazonaws.com/x.txt", // not a certificate
      "https://s3.amazonaws.com/x.pem",
      "not a url",
    ]) {
      assert.equal(isSnsCertUrl(bad), false, bad);
    }
  });

  it("accepts a subscribe URL on the same hosts, where the path is AWS's own", () => {
    assert.ok(isSnsSubscribeUrl("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x"));
    assert.equal(isSnsSubscribeUrl("https://evil.test/?Action=ConfirmSubscription"), false);
    assert.equal(isSnsSubscribeUrl("http://sns.us-east-1.amazonaws.com/"), false);
  });
});

describe("the topic allow-list", () => {
  it("is exact: a signed message from somebody else's topic is still somebody else's", () => {
    assert.ok(isAllowedTopic(TOPIC, [TOPIC]));
    assert.equal(isAllowedTopic(`${TOPIC}-other`, [TOPIC]), false);
    assert.equal(isAllowedTopic(TOPIC, []), false);
  });

  it("reads the environment variable as a list however it is spaced", () => {
    assert.deepEqual(parseTopicArns(` ${TOPIC}, ${TOPIC}-two `), [TOPIC, `${TOPIC}-two`]);
    assert.deepEqual(parseTopicArns(undefined), []);
    assert.deepEqual(parseTopicArns(""), []);
  });
});

describe("notificationEvents: SES", () => {
  const bounce = (over: Record<string, unknown> = {}) => ({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "Sam@Example.com", status: "5.1.1" }],
      ...over,
    },
    mail: { messageId: "0100018b-ses-message-id", source: "visits@sweetspot.example.com" },
  });

  it("marks a permanent bounce's recipients, lowercased, with the provider's subtype", () => {
    assert.deepEqual(notificationEvents(bounce()), [
      { kind: "email.bounce", emails: ["sam@example.com"], providerMessageId: "0100018b-ses-message-id", code: "Permanent/General" },
    ]);
  });

  it("leaves a transient bounce alone: a full mailbox is not a wrong address, and SES retries it", () => {
    assert.deepEqual(notificationEvents(bounce({ bounceType: "Transient", bounceSubType: "MailboxFull" })), []);
  });

  it("reads a complaint, and keeps the feedback type", () => {
    const events = notificationEvents({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "sam@example.com" }], complaintFeedbackType: "abuse" },
      mail: { messageId: "mid" },
    });
    assert.deepEqual(events, [{ kind: "email.complaint", emails: ["sam@example.com"], providerMessageId: "mid", code: "abuse" }]);
  });

  it("reads SES's event-publishing spelling of the same thing", () => {
    // Event publishing says `eventType`; the notification topic says `notificationType`. Same payload.
    const events = notificationEvents({ ...bounce(), notificationType: undefined, eventType: "Bounce" });
    assert.equal(events[0]?.kind, "email.bounce");
  });

  it("reads a delivery as a delivery and suppresses nothing", () => {
    const events = notificationEvents({ notificationType: "Delivery", delivery: { recipients: ["sam@example.com"] }, mail: { messageId: "mid" } });
    assert.deepEqual(events, [{ kind: "email.delivered", emails: ["sam@example.com"], providerMessageId: "mid" }]);
  });

  it("ignores a bounce that names nobody, and a payload it does not read", () => {
    assert.deepEqual(notificationEvents(bounce({ bouncedRecipients: [] })), []);
    assert.deepEqual(notificationEvents({ notificationType: "DeliveryDelay", mail: { messageId: "mid" } }), []);
  });
});

describe("notificationEvents: SMS", () => {
  it("reads an inbound STOP as the patient's opt-out", () => {
    assert.deepEqual(
      notificationEvents({ originationNumber: "+14155550100", destinationNumber: "+15105550123", messageKeyword: "STOP", messageBody: "STOP" }),
      [{ kind: "sms.optout", phone: "+14155550100" }],
    );
  });

  it("reads START as the way back", () => {
    assert.deepEqual(notificationEvents({ originationNumber: "4155550100", messageBody: "start" }), [{ kind: "sms.optin", phone: "+14155550100" }]);
  });

  it("ignores an inbound text that is a reply rather than a command", () => {
    assert.deepEqual(notificationEvents({ originationNumber: "+14155550100", messageBody: "sure, see you tuesday" }), []);
  });

  it("reads an already-opted-out number out of SNS's own delivery logging", () => {
    // The patient texted STOP to a message of ours, AWS answered it, and this is how we find out.
    assert.deepEqual(
      notificationEvents({ status: "FAILURE", delivery: { destination: "+14155550100", providerResponse: "Phone has opted out of receiving messages" } }),
      [{ kind: "sms.optout", phone: "+14155550100" }],
    );
  });

  it("reads a carrier failure as a failure, with a constant rather than the carrier's sentence", () => {
    assert.deepEqual(notificationEvents({ status: "FAILURE", delivery: { destination: "+14155550100", providerResponse: "Invalid phone number" } }), [
      { kind: "sms.failed", phone: "+14155550100", code: "invalid_number" },
    ]);
  });

  it("says nothing about a successful SMS delivery", () => {
    assert.deepEqual(notificationEvents({ status: "SUCCESS", delivery: { destination: "+14155550100", providerResponse: "Message has been accepted by phone" } }), []);
  });
});
