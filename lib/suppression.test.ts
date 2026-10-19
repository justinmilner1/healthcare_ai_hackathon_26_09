// Unit tests for §8.1's rule: which channels are closed, why, and how that reads.
//
// The rule is pure and lives in one place precisely so it can be stated once here and applied in four places
// (the invite, the code, the summary notice and the deletion confirmation, all in lib/notify.ts). The two
// cases worth reading first are the ones that caught real mistakes: a closed channel is `skipped` and not
// `failed`, because `failed` is what the job retries; and `smsKeyword` reads only the first word, because the
// alternative is a patient's answer to Sweetie turning their own invites off.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedChannels,
  normalizeEmail,
  normalizePhone,
  smsKeyword,
  SUPPRESSED_REASONS,
  suppressedReason,
  SUPPRESSION_CODES,
  suppressionLabel,
  suppressionOn,
  suppressions,
} from "./suppression";

const AT = new Date("2026-10-14T09:00:00.000Z");

describe("suppressions", () => {
  it("is empty for a patient nothing has gone wrong with", () => {
    assert.deepEqual(suppressions({}), []);
    assert.deepEqual(suppressions(null), []);
    assert.deepEqual(allowedChannels(["sms", "email"], {}), ["sms", "email"]);
  });

  it("closes email on a bounce and on a complaint, keeping the provider's word for it", () => {
    const bounced = suppressions({ emailUndeliverableAt: AT, emailUndeliverableReason: "bounce" });
    assert.deepEqual(bounced, [{ channel: "email", code: "bounce", at: AT }]);
    const spam = suppressions({ emailUndeliverableAt: AT, emailUndeliverableReason: "complaint" });
    assert.equal(spam[0].code, "complaint");
  });

  it("closes email even when the reason was never recorded", () => {
    // A row marked by an older build, or by hand in the runbook. The date is the fact; the reason is colour.
    assert.deepEqual(suppressions({ emailUndeliverableAt: AT }), [{ channel: "email", code: "undeliverable", at: AT }]);
  });

  it("closes sms on a STOP", () => {
    assert.deepEqual(suppressions({ smsOptOutAt: AT }), [{ channel: "sms", code: "stop", at: AT }]);
    assert.deepEqual(allowedChannels(["sms", "email"], { smsOptOutAt: AT }), ["email"]);
  });

  it("takes an ISO string as readily as a Date, because this crosses JSON to the dashboard", () => {
    assert.deepEqual(suppressionOn({ smsOptOutAt: AT.toISOString() }, "sms"), { channel: "sms", code: "stop", at: AT });
  });

  it("reads an unparsable date as closed with no date rather than as open", () => {
    // The column said something went wrong. Not being able to say when is not a reason to send again.
    assert.deepEqual(suppressions({ smsOptOutAt: "not a date" }), [{ channel: "sms", code: "stop", at: null }]);
  });

  it("keeps the caller's channel order", () => {
    assert.deepEqual(allowedChannels(["email", "sms"], {}), ["email", "sms"]);
  });

  it("gives a reason that names what happened and nobody it happened to", () => {
    for (const facts of [{ smsOptOutAt: AT }, { emailUndeliverableAt: AT, emailUndeliverableReason: "bounce" }]) {
      const channel = "smsOptOutAt" in facts ? "sms" : "email";
      const reason = suppressedReason(facts, channel)!;
      assert.match(reason, /design §8\.1/);
      assert.doesNotMatch(reason, /@|\+\d/);
    }
    assert.equal(suppressedReason({}, "email"), null);
    assert.match(suppressedReason({ emailUndeliverableAt: AT, emailUndeliverableReason: "complaint" }, "email")!, /spam/);
  });

  it("enumerates every reason it can give, so lib/delivery.ts can recognise one of ours (T74)", () => {
    // The list is derived from the codes rather than copied, which is the whole point: a reason missing from
    // it reads on the dashboard as a backend's own words and gets mapped away.
    for (const code of SUPPRESSION_CODES) {
      const facts = code === "stop" ? { smsOptOutAt: AT } : { emailUndeliverableAt: AT, emailUndeliverableReason: code };
      const reason = suppressedReason(facts, code === "stop" ? "sms" : "email")!;
      assert.ok(SUPPRESSED_REASONS.includes(reason), `${code}: ${reason}`);
    }
    assert.equal(SUPPRESSED_REASONS.length, new Set(SUPPRESSED_REASONS).size, "no duplicates to dedupe on screen");
  });

  it("labels a closed channel short enough for a dashboard cell", () => {
    const labels = suppressions({ smsOptOutAt: AT, emailUndeliverableAt: AT, emailUndeliverableReason: "bounce" }).map(suppressionLabel);
    assert.deepEqual(labels, ["Texts stopped (STOP)", "Email bounced"]);
    for (const label of labels) assert.ok(label.length <= 28, label);
  });
});

describe("smsKeyword", () => {
  it("reads every spelling of stop and start AWS reserves", () => {
    for (const body of ["STOP", "stop", " Stop ", "STOP.", "stopall", "UNSUBSCRIBE", "cancel", "quit", "end", "optout", "revoke"]) {
      assert.equal(smsKeyword(body), "stop", body);
    }
    for (const body of ["START", "unstop", "YES", "subscribe", "optin"]) assert.equal(smsKeyword(body), "start", body);
  });

  it("reads only the first word, so an answer to Sweetie is not a command", () => {
    assert.equal(smsKeyword("I need to stop eating so late"), null);
    assert.equal(smsKeyword("yes please, 7pm works"), "start");
    assert.equal(smsKeyword("Stop please"), "stop");
  });

  it("is nothing for nothing", () => {
    for (const body of ["", "   ", null, undefined]) assert.equal(smsKeyword(body), null);
  });
});

describe("normalizing a number and an address", () => {
  it("puts a ten-digit US number in the shape the database stores", () => {
    for (const raw of ["4155550100", "(415) 555-0100", "415-555-0100", "+1 415 555 0100", "14155550100"]) {
      assert.equal(normalizePhone(raw), "+14155550100", raw);
    }
  });

  it("keeps a country code it was given", () => {
    assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  });

  it("is null for something that is not a number at all", () => {
    for (const raw of ["", "n/a", "12", null, undefined]) assert.equal(normalizePhone(raw), null, String(raw));
  });

  it("lowercases an address and unwraps the name a bounce wraps it in", () => {
    assert.equal(normalizeEmail("Sam.Sample@Example.COM"), "sam.sample@example.com");
    assert.equal(normalizeEmail("Sam Sample <sam@example.com>"), "sam@example.com");
    assert.equal(normalizeEmail("not an address"), null);
    assert.equal(normalizeEmail(null), null);
  });
});
