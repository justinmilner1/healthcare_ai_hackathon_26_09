import assert from "node:assert/strict";
import test from "node:test";
import { dexcomCardHint, type DexcomHint } from "./dexcomHint";

/** A real patient on the default offline deployment: sandbox Dexcom, no credentials, nothing shared. */
const base: DexcomHint = {
  env: "sandbox",
  configured: false,
  canConnect: false,
  sandboxPatient: false,
  imported: false,
  importRange: null,
  uploaded: false,
};

const hint = (over: Partial<DexcomHint> = {}) => dexcomCardHint({ ...base, ...over });

const OPERATOR = /not configured|demo mode|credential|DEXCOM_|environment variable/i;

test("a visit with the patient's CSV in it is told so, not that nothing is configured (T71)", () => {
  const said = hint({ uploaded: true });
  assert.match(said, /Your Clarity CSV is in\./);
  assert.doesNotMatch(said, OPERATOR);
});

test("with no upload and no credentials, the patient is told what they can do", () => {
  const said = hint();
  assert.match(said, /Upload your Clarity CSV export/);
  assert.doesNotMatch(said, OPERATOR);
});

test("no state names the deployment's configuration to the patient (§2.5)", () => {
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true])
          for (const imported of [false, true])
            for (const uploaded of [false, true])
              for (const importRange of [null, "1 Oct – 8 Oct"]) {
                const said = hint({ env, configured, canConnect, sandboxPatient, imported, uploaded, importRange });
                assert.ok(said.length > 0, "every state has a hint");
                assert.doesNotMatch(said, OPERATOR, `${env}/${configured}/${canConnect}/${sandboxPatient}/${imported}/${uploaded}`);
              }
});

test("an OAuth import is described by its date range, as it was before", () => {
  assert.equal(hint({ configured: true, canConnect: true, imported: true, uploaded: true, importRange: "1 Oct – 8 Oct" }), "1 Oct – 8 Oct");
  assert.equal(
    hint({ configured: true, canConnect: true, sandboxPatient: true, imported: true, importRange: "1 Oct – 8 Oct" }),
    "1 Oct – 8 Oct · Synthetic readings",
  );
});

test("an import with no range still reads as data the patient has shared", () => {
  assert.equal(hint({ configured: true, canConnect: true, imported: true }), "Your Dexcom readings are in.");
  assert.equal(hint({ configured: true, canConnect: true, sandboxPatient: true, imported: true }), "Your synthetic Dexcom readings are in.");
});

test("what follows an upload is the next thing the patient can do, whatever the deployment is", () => {
  assert.match(hint({ uploaded: true }), /Upload a newer export any time/);
  assert.match(hint({ uploaded: true, configured: true, canConnect: true }), /also connect Dexcom/);
  assert.match(hint({ uploaded: true, configured: true }), /separate synthetic-data session/);
  assert.match(hint({ uploaded: true, configured: true, env: "production" }), /Upload a newer export any time/);
});

test("with nothing shared, the connect states are unchanged", () => {
  assert.equal(hint({ configured: true }), "Demo connects a separate synthetic-data session. Your existing uploads stay unchanged.");
  assert.equal(hint({ configured: true, env: "production" }), "This demonstration visit cannot connect to a real Dexcom account.");
  assert.equal(hint({ configured: true, canConnect: true }), "Authorize on Dexcom and return here. Your last 7 days of readings are imported.");
  assert.equal(
    hint({ configured: true, canConnect: true, sandboxPatient: true }),
    "Authorize on Dexcom and return here. Only synthetic readings are imported.",
  );
});
