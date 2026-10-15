// Unit tests for demo mode's rules (T32, design §13.4).
//
// The address allow-list is the half worth most of this file: it is what stands between a seeded demo
// practice and a text to somebody's real phone, and it is a predicate over strings, so there is no excuse
// for not asserting the awkward ones. The log label is checked through formatLine, because what §11.1's
// alarm filters read is the line, not the function that set the flag.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_BLOCKED, DEMO_BLOCKED_LABEL, demoBlockReason, isDemoBlocked, isDemoPractice, isSyntheticEmail, isSyntheticPhone } from "./demo";
import { formatLine, markDemoPractice, runWithRequestContext } from "./log";

const REQUEST = { requestId: "11111111-2222-4333-8444-555555555555", route: "GET /x" };

describe("demo practices (§13.4)", () => {
  describe("isDemoPractice", () => {
    it("is the flag, and false for a practice that is not there", () => {
      assert.equal(isDemoPractice({ isDemo: true }), true);
      assert.equal(isDemoPractice({ isDemo: false }), false);
      assert.equal(isDemoPractice(null), false);
      assert.equal(isDemoPractice(undefined), false);
    });
  });

  describe("isSyntheticEmail", () => {
    it("accepts the reserved TLDs of RFC 2606 and RFC 6761", () => {
      for (const address of [
        "demo@sweetspot.local",
        "sam.sample@sweetspot.local",
        "front.desk@practice.test",
        "someone@anything.invalid",
        "a@b.example",
        "nobody@localhost",
        "staff@deep.sub.domain.test",
      ]) {
        assert.equal(isSyntheticEmail(address), true, address);
      }
    });

    it("accepts example.com and its subdomains, and nothing that merely looks like them", () => {
      assert.equal(isSyntheticEmail("someone@example.com"), true);
      assert.equal(isSyntheticEmail("someone@mail.example.org"), true);
      assert.equal(isSyntheticEmail("someone@example.net"), true);
      // The failure this exists to stop: a registrable domain that reads like a reserved one. Somebody owns
      // `example-endo.com` and `notexample.com`, and the e2e suite's own provider addresses are the first.
      assert.equal(isSyntheticEmail("someone@example-endo.com"), false);
      assert.equal(isSyntheticEmail("someone@notexample.com"), false);
      assert.equal(isSyntheticEmail("someone@example.com.co"), false);
    });

    it("rejects a real address, and anything that is not an address at all", () => {
      for (const address of ["patient@gmail.com", "clinic@sweetspot.health", "", "no-at-sign", "@nothing.test", null, undefined]) {
        assert.equal(isSyntheticEmail(address as string), false, String(address));
      }
    });

    it("ignores case, surrounding space and a trailing root dot", () => {
      assert.equal(isSyntheticEmail("Demo@SweetSpot.LOCAL"), true);
      assert.equal(isSyntheticEmail("demo@sweetspot.local. "), true);
      assert.equal(isSyntheticEmail("Patient@Gmail.com"), false);
    });
  });

  describe("isSyntheticPhone", () => {
    it("accepts the NANP's fictitious 555-01xx range, however it is punctuated", () => {
      for (const number of ["+14155550100", "+1 415 555 0100", "415-555-0199", "(415) 555-0142", "4155550100"]) {
        assert.equal(isSyntheticPhone(number), true, number);
      }
    });

    it("rejects the assignable rest of the 555 prefix", () => {
      // 555-1234 is not reserved, and the e2e suite's own `+1415555NNNN` numbers land here: a demo practice
      // does not text them, which is the answer this rule exists to give.
      assert.equal(isSyntheticPhone("+14155551234"), false);
      assert.equal(isSyntheticPhone("+14155550200"), false);
    });

    it("rejects a real number, a short one, and a non-number", () => {
      for (const number of ["+14155552671", "+442071234567", "555", "", "not a number", null, undefined]) {
        assert.equal(isSyntheticPhone(number as string), false, String(number));
      }
    });
  });

  describe("demoBlockReason", () => {
    it("says nothing at all about a practice that is not a demo", () => {
      assert.equal(demoBlockReason(false, "email", "patient@gmail.com"), null);
      assert.equal(demoBlockReason(false, "sms", "+14155552671"), null);
    });

    it("lets a demo practice message a reserved address or number", () => {
      assert.equal(demoBlockReason(true, "email", "sam.sample@sweetspot.local"), null);
      assert.equal(demoBlockReason(true, "sms", "+14155550100"), null);
    });

    it("has a reason the dashboard can recognise without matching on words", () => {
      assert.equal(isDemoBlocked(DEMO_BLOCKED), true);
      assert.equal(isDemoBlocked("sns: The security token included in the request is invalid."), false);
      assert.equal(isDemoBlocked(null), false);
      assert.equal(DEMO_BLOCKED_LABEL.length < 60, true, "it goes under a pill in a table cell");
    });

    it("blocks everything else, with a reason that names no address", () => {
      const reason = demoBlockReason(true, "email", "patient@gmail.com");
      assert.equal(reason, DEMO_BLOCKED);
      assert.equal(reason?.includes("gmail"), false, "the reason is shown to staff and written to the log (§10.3)");
      assert.equal(demoBlockReason(true, "sms", "+14155552671"), DEMO_BLOCKED);
      // Nothing on file is not a destination, so it is blocked too; the caller's own "no phone on file"
      // never gets the chance to say otherwise, which is the safe way round.
      assert.equal(demoBlockReason(true, "email", null), DEMO_BLOCKED);
    });

    it("judges the channel it is given, not the shape of the destination", () => {
      // A phone number is not a synthetic *address*, and a reserved address is not a synthetic *number*.
      assert.equal(demoBlockReason(true, "email", "+14155550100"), DEMO_BLOCKED);
      assert.equal(demoBlockReason(true, "sms", "demo@sweetspot.local"), DEMO_BLOCKED);
    });
  });

  describe("markDemoPractice", () => {
    it("labels every later line in the request, so the alarms can leave them out (§11.1)", () => {
      runWithRequestContext(REQUEST, () => {
        assert.equal(JSON.parse(formatLine("error", "job_failed")).demo, undefined);
        assert.equal(markDemoPractice({ isDemo: true }), true);
        const line = JSON.parse(formatLine("error", "job_failed"));
        assert.equal(line.demo, true);
        assert.equal(line.requestId, REQUEST.requestId, "and the line is otherwise untouched");
      });
    });

    it("labels nothing for a real practice", () => {
      // The same context object as the test above, on purpose: runWithRequestContext copies it, so that
      // test's label cannot reach this one.
      runWithRequestContext(REQUEST, () => {
        assert.equal(markDemoPractice({ isDemo: false }), false);
        assert.equal(markDemoPractice(null), false);
        assert.equal(JSON.parse(formatLine("info", "request")).demo, undefined);
      });
    });

    it("does not throw outside a request, where there is no context to label", () => {
      assert.equal(markDemoPractice({ isDemo: true }), true);
      assert.equal(JSON.parse(formatLine("info", "request")).demo, undefined);
    });
  });
});
