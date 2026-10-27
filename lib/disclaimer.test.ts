// Unit tests for the clinician's standing caveat (T171, design §2.6, §7.3, §7.4, §12.1).
//
// The test the ticket was filed for is `no line claims a generated summary or an upload on a visit that has
// neither`. The footer was two literals, both opening "AI-generated from patient-uploaded data", rendered
// outside every branch of both of the clinician's surfaces — so a visit nobody had started printed that
// claim under "Nothing to summarize yet", and a check-in with no exports printed it one line under the
// page's own "This summary is from the conversation only."
//
// Every state the footer can be in is run through one rule here, and the rule is the invariant rather than
// the strings: each line says whether it claims a generated summary, whether it names an upload as the
// source, and whether it names §7.3's reviewer, and nothing may claim what the facts do not carry. A
// reword of either sentence cannot put the claim back.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clinicianCaveat, sharedAnyExport, type ClinicianCaveat, type ClinicianCaveatFacts } from "./disclaimer";

/** Anything that reads as the page above having been written by the model. */
const GENERATED = /ai-generated|generated from/i;

/** Anything that reads as the patient having uploaded what the page is made of. Deliberately not a bare
 *  /upload/: "the patient has not … shared any data" is the absence, and the sheet says that elsewhere. */
const UPLOADED = /uploaded data|from (?:their|the patient's) (?:dexcom|exports?|files?|uploads?)/i;

const REVIEWER = "Dr Yusuf";

/** Every combination of the three facts, so the invariants below are about the footer and not one sentence. */
const ALL: ClinicianCaveatFacts[] = [false, true].flatMap((generated) =>
  [false, true].flatMap((uploads) => [undefined, REVIEWER].map((reviewedBy) => ({ generated, uploads, reviewedBy }))),
);

const linesWhere = (p: (f: ClinicianCaveatFacts) => boolean): ClinicianCaveat[] =>
  ALL.filter(p).map((f) => clinicianCaveat(f));

describe("the clinician's caveat cannot claim what the visit does not carry", () => {
  it("claims no generated summary and no upload on a visit with neither (the empty state, §2.6)", () => {
    for (const line of linesWhere((f) => !f.generated)) {
      assert.equal(line.claimsGenerated, false, `claimsGenerated on: ${line.text}`);
      assert.equal(line.claimsUploads, false, `claimsUploads on: ${line.text}`);
      assert.doesNotMatch(line.text, GENERATED, "the claim this ticket was filed for");
      assert.doesNotMatch(line.text, UPLOADED, "the source claim this ticket was filed for");
      // And it says what the state is, so the sentence is not simply shorter than it was.
      assert.match(line.text, /nothing has been generated for this visit yet/i);
    }
  });

  it("does not name uploads as the source on a summary written from the conversation only (T143)", () => {
    for (const line of linesWhere((f) => f.generated && !f.uploads)) {
      assert.equal(line.claimsUploads, false, `claimsUploads on: ${line.text}`);
      assert.doesNotMatch(line.text, UPLOADED, "the source claim this ticket was filed for");
      // It still says where the brief did come from: the §2.5 check-in the patient typed or spoke.
      assert.match(line.text, /the patient's own answers/i);
      assert.equal(line.claimsGenerated, true, "a summary was generated, and the sentence may say so");
    }
  });

  it("names uploads exactly where the patient shared one, and nowhere else", () => {
    assert.deepEqual(
      ALL.map((f) => clinicianCaveat(f).claimsUploads),
      ALL.map((f) => f.generated && f.uploads),
    );
    for (const line of linesWhere((f) => f.generated && f.uploads)) assert.match(line.text, UPLOADED);
  });

  it("still says verify-and-does-not-diagnose in every state, which is why the line is there (§2.6)", () => {
    for (const line of ALL.map(clinicianCaveat)) {
      assert.equal(line.warnsVerify, true, `warnsVerify on: ${line.text}`);
      assert.match(line.text, /verify with the patient/i);
      assert.match(line.text, /it flags, it does not diagnose/);
    }
  });

  it("names §7.3's reviewer wherever one signed off, and claims none where nobody did", () => {
    for (const line of linesWhere((f) => Boolean(f.reviewedBy))) {
      assert.equal(line.namesReviewer, true, `namesReviewer on: ${line.text}`);
      assert.ok(line.text.includes(REVIEWER), `the reviewer is missing from: ${line.text}`);
    }
    for (const line of linesWhere((f) => !f.reviewedBy)) {
      assert.equal(line.namesReviewer, false, `namesReviewer on: ${line.text}`);
      assert.doesNotMatch(line.text, /reviewed by/i);
    }
  });

  it("does not credit a reviewer with a page that is empty: it says the summary is gone (lib/review.ts)", () => {
    const line = clinicianCaveat({ generated: false, uploads: true, reviewedBy: REVIEWER });
    assert.match(line.text, /sign-off is from a summary this visit no longer has/i);
    assert.equal(line.claimsGenerated, false);
  });

  it("the ordinary state is word for word what it was, reviewed and not (§7.3)", () => {
    assert.equal(
      clinicianCaveat({ generated: true, uploads: true }).text,
      "AI-generated from patient-uploaded data. No clinician has reviewed this before you. Verify with the patient; it flags, it does not diagnose.",
    );
    assert.equal(
      clinicianCaveat({ generated: true, uploads: true, reviewedBy: REVIEWER }).text,
      `AI-generated from patient-uploaded data, reviewed by ${REVIEWER}. Verify with the patient; it flags, it does not diagnose.`,
    );
  });

  it("the brief and the sheet are given one sentence per state, so they cannot drift (§7.4)", () => {
    // Same facts in, same string out: the two surfaces each render components/Disclaimer.tsx over this.
    for (const f of ALL) assert.equal(clinicianCaveat(f).text, clinicianCaveat({ ...f }).text);
    assert.equal(new Set(ALL.map((f) => clinicianCaveat(f).text)).size, 6, "three provenances, each with and without a sign-off, minus the two the empty state shares");
  });
});

describe("sharedAnyExport", () => {
  it("is true of any one of §2.5's three exports and false of none", () => {
    assert.equal(sharedAnyExport({ hasDexcom: false, hasLocation: false, hasWhoop: false }), false);
    assert.equal(sharedAnyExport({ hasDexcom: true, hasLocation: false, hasWhoop: false }), true);
    assert.equal(sharedAnyExport({ hasDexcom: false, hasLocation: true, hasWhoop: false }), true);
    assert.equal(sharedAnyExport({ hasDexcom: false, hasLocation: false, hasWhoop: true }), true);
  });
});
