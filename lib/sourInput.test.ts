// Unit tests for Sour's input fingerprint (T15, design §7.1). Pure arithmetic over strings: no database,
// no model, so this half of the idempotency rule is pinned down everywhere `npm test` runs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { narrativeSource, sourInputHash, sourInputsFor, type SourInputs } from "./sourInput";

const base: SourInputs = {
  intake: JSON.stringify({ fields: { meals: { value: "pasta most nights", confidence: "high" } }, turns: 2, wrapped: true, skipped: [], flagged: null }),
  notes: "Meals: pasta most nights",
  visitType: "follow_up",
  reason: "mornings running high",
  uploads: [
    { id: "upl_dex", kind: "dexcom", parsedRows: 2016 },
    { id: "upl_whoop", kind: "whoop", parsedRows: 7 },
  ],
  source: "model",
};

const hash = (patch: Partial<SourInputs> = {}) => sourInputHash({ ...base, ...patch });

describe("sourInputHash", () => {
  it("is a hex sha-256 and the same for the same inputs", () => {
    assert.match(hash(), /^[0-9a-f]{64}$/);
    assert.equal(hash(), hash(), "the same inputs twice must be the same summary");
  });

  it("does not care what order the uploads came back in", () => {
    assert.equal(hash({ uploads: [...base.uploads].reverse() }), hash(), "one query's ordering is not a change in the data");
  });

  it("does not care what order Sweetie wrote the intake's keys in", () => {
    const resorted = JSON.stringify({ flagged: null, skipped: [], wrapped: true, turns: 2, fields: { meals: { confidence: "high", value: "pasta most nights" } } });
    assert.equal(hash({ intake: resorted }), hash(), "the same answers are the same answers");
  });

  it("changes when the patient says something new", () => {
    const more = JSON.parse(base.intake!) as { fields: Record<string, unknown>; turns: number };
    more.fields.symptoms = { value: "shaky before lunch", confidence: "high" };
    more.turns = 3;
    assert.notEqual(hash({ intake: JSON.stringify(more) }), hash());
    assert.notEqual(hash({ notes: `${base.notes}\nSymptoms: shaky before lunch` }), hash());
  });

  it("changes when a file arrives, is replaced, or parses to a different number of rows", () => {
    assert.notEqual(hash({ uploads: [...base.uploads, { id: "upl_tl", kind: "timeline", parsedRows: 31 }] }), hash(), "a new file is new data");
    assert.notEqual(hash({ uploads: [{ id: "upl_dex2", kind: "dexcom", parsedRows: 2016 }, base.uploads[1]] }), hash(), "a re-uploaded export is a new Upload row");
    assert.notEqual(hash({ uploads: [{ ...base.uploads[0], parsedRows: 2017 }, base.uploads[1]] }), hash());
    assert.notEqual(hash({ uploads: [] }), hash());
  });

  it("changes when the visit itself is re-described", () => {
    assert.notEqual(hash({ visitType: "annual" }), hash());
    assert.notEqual(hash({ reason: "lows overnight" }), hash());
    assert.notEqual(hash({ visitType: null }), hash());
  });

  it("separates a model narrative from the no-key placeholder", () => {
    // The point of carrying the source: configuring a key must not leave the clinician looking at
    // "LLM not configured" forever just because nothing about the patient changed.
    assert.notEqual(hash({ source: "unconfigured" }), hash({ source: "model" }));
    assert.equal(narrativeSource(true), "model");
    assert.equal(narrativeSource(false), "unconfigured");
  });

  it("treats an empty visit as its own fingerprint rather than throwing", () => {
    const empty = sourInputHash({ intake: null, notes: null, visitType: null, reason: null, uploads: [], source: "model" });
    assert.match(empty, /^[0-9a-f]{64}$/);
    assert.notEqual(empty, hash());
  });

  it("hashes intake that is not valid JSON as the text it is", () => {
    assert.equal(hash({ intake: "{not json" }), hash({ intake: "{not json" }));
    assert.notEqual(hash({ intake: "{not json" }), hash({ intake: "{also not json" }));
  });
});

describe("sourInputsFor", () => {
  it("takes the four visit columns and the uploads, and nothing else", () => {
    const visit = { intake: "{}", notes: "n", visitType: "annual", reason: "r", id: "v1", status: "intake_done" };
    const inputs = sourInputsFor(visit, [{ id: "u1", kind: "dexcom", parsedRows: 1 }], "model");
    assert.deepEqual(inputs, { intake: "{}", notes: "n", visitType: "annual", reason: "r", uploads: [{ id: "u1", kind: "dexcom", parsedRows: 1 }], source: "model" });
  });

  it("gives the same fingerprint from the bundle's uploads and the runner's upload refs", () => {
    // lib/bundle.ts passes full Upload rows and lib/sourRun.ts passes a three-column select; both must agree
    // or the page would call a current summary stale and every open would regenerate it.
    const visit = { intake: "{}", notes: null, visitType: null, reason: null };
    const fromBundle = [{ id: "u1", kind: "dexcom", parsedRows: 3, visitId: "v1", filename: "clarity.csv", bytes: 99, createdAt: new Date(), s3Key: null }];
    const fromRunner = [{ id: "u1", kind: "dexcom", parsedRows: 3 }];
    assert.equal(sourInputHash(sourInputsFor(visit, fromBundle, "model")), sourInputHash(sourInputsFor(visit, fromRunner, "model")));
  });
});
