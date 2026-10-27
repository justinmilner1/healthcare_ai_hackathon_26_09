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
//
// T174 added the fourth fact and the fourth reading: a summary whose narrative the model never wrote (§6.3,
// §3.5 — the sandbox, the gate, the demo, and any deployment whose circuit has opened mid-clinic). The brief
// and the printed sheet carried "AI-generated from patient-uploaded data" over a page whose Patterns and Ask
// the patient both read "Not generated.", which is the claim crossed with itself in one frame. So the cross
// product below is over four facts rather than three, and the two claims are asserted apart: `claimsUploads`
// is about the data and survives that state, `claimsGenerated` is about the writing and does not.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clinicianCaveat, sharedAnyExport, type ClinicianCaveat, type ClinicianCaveatFacts } from "./disclaimer";

/** Anything that reads as the page above having been written by the model. */
const GENERATED = /ai-generated|generated from/i;

/** Anything that reads as the patient having uploaded what the page is made of. Deliberately not a bare
 *  /upload/: "the patient has not … shared any data" is the absence, and the sheet says that elsewhere. */
const UPLOADED = /uploaded data|from (?:their|the patient's) (?:dexcom|exports?|files?|uploads?)/i;

const REVIEWER = "Dr Yusuf";

/** Every combination of the four facts, so the invariants below are about the footer and not one sentence. */
const ALL: ClinicianCaveatFacts[] = [false, true].flatMap((generated) =>
  [false, true].flatMap((uploads) =>
    [false, true].flatMap((narrativeWritten) =>
      [undefined, REVIEWER].map((reviewedBy) => ({ generated, uploads, narrativeWritten, reviewedBy })),
    ),
  ),
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
    }
    for (const line of linesWhere((f) => f.generated && !f.uploads && f.narrativeWritten)) {
      assert.equal(line.claimsGenerated, true, "the model wrote this one, and the sentence may say so");
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
    const line = clinicianCaveat({ generated: false, uploads: true, narrativeWritten: false, reviewedBy: REVIEWER });
    assert.match(line.text, /sign-off is from a summary this visit no longer has/i);
    assert.equal(line.claimsGenerated, false);
  });

  it("the ordinary state is word for word what it was, reviewed and not (§7.3)", () => {
    assert.equal(
      clinicianCaveat({ generated: true, uploads: true, narrativeWritten: true }).text,
      "AI-generated from patient-uploaded data. No clinician has reviewed this before you. Verify with the patient; it flags, it does not diagnose.",
    );
    assert.equal(
      clinicianCaveat({ generated: true, uploads: true, narrativeWritten: true, reviewedBy: REVIEWER }).text,
      `AI-generated from patient-uploaded data, reviewed by ${REVIEWER}. Verify with the patient; it flags, it does not diagnose.`,
    );
  });

  it("the brief and the sheet are given one sentence per state, so they cannot drift (§7.4)", () => {
    // Same facts in, same string out: the two surfaces each render components/Disclaimer.tsx over this.
    for (const f of ALL) assert.equal(clinicianCaveat(f).text, clinicianCaveat({ ...f }).text);
    assert.equal(
      new Set(ALL.map((f) => clinicianCaveat(f).text)).size,
      10,
      "four provenances over two sources, each with and without a sign-off, plus the empty state's own pair",
    );
  });
});

// T174. The frame this was filed from: `desktop-journey-15-print-sheet.png` on the gate's own run, where the
// sheet said "Patterns · Not generated." and then signed itself off as AI-generated four inches below.
describe("the clinician's caveat does not credit the model with a narrative it never wrote (T174, §6.3, §7)", () => {
  const degraded = (over: Partial<ClinicianCaveatFacts> = {}): ClinicianCaveat =>
    clinicianCaveat({ generated: true, uploads: true, narrativeWritten: false, ...over });

  it("claims nothing was AI-generated wherever the model wrote no narrative", () => {
    for (const line of linesWhere((f) => f.generated && !f.narrativeWritten)) {
      assert.equal(line.claimsGenerated, false, `claimsGenerated on: ${line.text}`);
      assert.doesNotMatch(line.text, GENERATED, "the claim this ticket was filed for");
    }
    // And the one asserted as data rather than as prose, across the whole cross product: the footer credits
    // the model exactly where the model wrote something, and nowhere else.
    assert.deepEqual(
      ALL.map((f) => clinicianCaveat(f).claimsGenerated),
      ALL.map((f) => f.generated && f.narrativeWritten),
    );
  });

  it("still names the source, because the numbers are real and came from somewhere (§7)", () => {
    // The data's provenance is a separate claim from the writing's, and it is the half that survives: the
    // time in range, the average, the GMI and the spikes were computed from what the patient shared
    // (lib/sour.ts, lib/glucose.ts), which is the part "AI-generated" was telling a clinician to discount.
    assert.match(degraded().text, UPLOADED);
    assert.equal(degraded().claimsUploads, true);
    assert.match(degraded().text, /computed from patient-uploaded data/i);
    // And the check-in with no exports keeps naming the answers it was built from (T143).
    assert.equal(degraded({ uploads: false }).claimsUploads, false);
    assert.doesNotMatch(degraded({ uploads: false }).text, UPLOADED);
    assert.match(degraded({ uploads: false }).text, /the patient's own answers/i);
  });

  it("does not restate narrativeNote: no deployment state, no variable, no administrator (§3.7, §10.6)", () => {
    for (const line of linesWhere((f) => f.generated && !f.narrativeWritten)) {
      // lib/sourState.ts `narrativeNote` owns which of §6.3's two states this is and what can be done about
      // it. This line owns what the reader is holding. The T170 split: one fact, one line that owns it.
      assert.doesNotMatch(line.text, /not configured|unavailable|gateway|retry/i, `the note restated in: ${line.text}`);
      assert.doesNotMatch(line.text, /patterns|questions/i, `the two lists restated in: ${line.text}`);
      assert.doesNotMatch(line.text, /practice setting|administrator|set Sweet Spot up/i);
      assert.doesNotMatch(line.text, /OPENAI|BEDROCK|API key|Parameter Store/i);
    }
  });

  it("§7.3's sign-off crosses this branch too: a brief reviewed in the degraded state names its reviewer", () => {
    assert.equal(degraded({ reviewedBy: REVIEWER }).namesReviewer, true);
    assert.ok(degraded({ reviewedBy: REVIEWER }).text.includes(REVIEWER));
    assert.match(degraded().text, /no clinician has reviewed this before you/i);
  });

  it("keeps the half that is true on every branch and must not be lost", () => {
    for (const line of linesWhere((f) => f.generated && !f.narrativeWritten)) {
      assert.equal(line.warnsVerify, true, `warnsVerify on: ${line.text}`);
      assert.match(line.text, /verify with the patient; it flags, it does not diagnose\./i);
    }
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
