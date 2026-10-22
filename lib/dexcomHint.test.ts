import assert from "node:assert/strict";
import test from "node:test";
import { dexcomCardHint, dexcomConnectControl, summaryDataInvite, type DexcomHint } from "./dexcomHint";

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

// T91 (§2.5, §9.2): which control the card offers. The states that matter are the ones where there is
// nothing to offer, because those used to be rendered as a disabled button.

const control = (over: Partial<DexcomHint> = {}) => dexcomConnectControl({ ...base, ...over });

test("with no credentials the card offers no connect control at all, not a disabled one (T91)", () => {
  // The default offline deployment: the README's, the check script's and the demo's.
  assert.equal(control(), "none");
  // And in every other shape a visit can have without credentials — a production switch, a synthetic
  // visit, a visit the server says may connect — since none of them can reach Dexcom either.
  for (const env of ["sandbox", "production"] as const)
    for (const canConnect of [false, true])
      for (const sandboxPatient of [false, true])
        assert.equal(control({ env, canConnect, sandboxPatient }), "none", `${env}/${canConnect}/${sandboxPatient}`);
});

test("with credentials the two controls are offered exactly as they were (§9.2)", () => {
  // A visit the server says may connect gets the real OAuth button, whichever Dexcom that is.
  assert.equal(control({ configured: true, canConnect: true }), "oauth");
  assert.equal(control({ configured: true, canConnect: true, env: "production" }), "oauth");
  assert.equal(control({ configured: true, canConnect: true, sandboxPatient: true }), "oauth");
  // A real visit on a sandbox deployment is offered the separate synthetic session instead (§13.4).
  assert.equal(control({ configured: true }), "demo");
  // A synthetic visit on a production deployment has nothing to connect to.
  assert.equal(control({ configured: true, env: "production", sandboxPatient: true }), "none");
  assert.equal(control({ configured: true, env: "production" }), "none");
});

test("the control and the hint agree: nothing on offer is never described as something to authorize", () => {
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true]) {
          const state = { env, configured, canConnect, sandboxPatient };
          if (control(state) !== "none") continue;
          // With no control on the card, the sentence under it cannot ask the patient to press one.
          assert.doesNotMatch(hint(state), /Authorize on Dexcom/, JSON.stringify(state));
        }
});

// T118 (§2.5, §2.7): the invitation on the patient's own summary while it holds no readings. Its button is
// a link to /s/<token>, so what it names has to be something that page offers once the patient is there.

const invite = (over: Partial<DexcomHint> = {}) =>
  summaryDataInvite({ control: control(over), sandboxPatient: (over.sandboxPatient ?? base.sandboxPatient) });

test("with no credentials the summary asks for the upload, not a connection (T118)", () => {
  // The default offline deployment: the README's, the check script's and the demo's. /s/<token> has no
  // Dexcom control on it at all there, only the file upload, so that is what the button names.
  const said = invite();
  assert.equal(said.action, "Upload your Dexcom export");
  assert.doesNotMatch(said.action, /Connect/i, "the destination has nothing to connect");
  assert.match(said.body, /Share your Dexcom export/);
  assert.doesNotMatch(said.body, /\bConnect\b/);
  assert.doesNotMatch(said.body, OPERATOR);
});

test("every uncredentialled shape of a real visit asks for the upload, since none of them can connect", () => {
  for (const env of ["sandbox", "production"] as const)
    for (const canConnect of [false, true]) {
      const said = invite({ env, canConnect });
      assert.equal(said.action, "Upload your Dexcom export", `${env}/${canConnect}`);
    }
});

test("with credentials the card still offers the connection (T118 changed nothing here)", () => {
  // The two states that reach a control, and the isSandbox branch the ticket pins at page.tsx:118.
  const real = invite({ configured: true, canConnect: true });
  assert.equal(real.action, "Connect Dexcom");
  assert.equal(real.body, "Connect your Dexcom export and Sweetie will turn your readings into a clear picture for you and your doctor.");
  const synthetic = invite({ configured: true, canConnect: true, sandboxPatient: true });
  assert.equal(synthetic.action, "Connect Dexcom");
  assert.equal(synthetic.body, "Connect Dexcom sandbox in Sweetie to import synthetic demo readings.");
  // A real visit on a sandbox deployment is offered the separate demonstration, which is still a connection.
  assert.equal(invite({ configured: true }).action, "Connect Dexcom");
});

test("a synthetic visit with nothing to connect gets no button, because its uploads are refused too", () => {
  // §13.4: /s/<token> renders its upload list for a real visit only, so there is no second path to name.
  // Credentials gone from under a demonstration record (production switch, or keys unset) is the state.
  for (const state of [{ sandboxPatient: true }, { configured: true, env: "production" as const, sandboxPatient: true }]) {
    const said = invite(state);
    assert.equal(said.action, null, JSON.stringify(state));
    assert.ok(said.body.length > 0, "the card still says where the readings are");
  }
});

test("no state puts the deployment's configuration in the patient's copy (§2.5, the T71 rule)", () => {
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true]) {
          const state = { env, configured, canConnect, sandboxPatient };
          const said = invite(state);
          const where = JSON.stringify(state);
          assert.ok(said.body.length > 0, `every state has a sentence: ${where}`);
          assert.doesNotMatch(said.body, OPERATOR, where);
          if (said.action !== null) assert.doesNotMatch(said.action, OPERATOR, where);
        }
});

test("the invitation and the control agree: a connection is named only where there is one", () => {
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true]) {
          const state = { env, configured, canConnect, sandboxPatient };
          const said = invite(state);
          const where = JSON.stringify(state);
          if (control(state) === "none") {
            // Nothing to connect at the destination, so neither the button nor the sentence may say so.
            assert.doesNotMatch(said.body, /\bconnect\b/i, where);
            if (said.action !== null) assert.doesNotMatch(said.action, /\bconnect\b/i, where);
          } else {
            assert.equal(said.action, "Connect Dexcom", where);
          }
        }
});

test("no invitation names a span, because this is the state with no data to take one from (T123)", () => {
  // §2.5, §2.7: the summary's hero and its three T114 strings all read the span off `stats.days`, and the
  // empty state is where there is no such number. "the past week" in the connect branch presumed what the
  // upload would hold, which is the claim T100 and T114 took off every other line of this page. A pattern
  // rather than the one literal: "a week", "this week", "the past week", "7 days" and "the last 24 hours"
  // all make the same promise, and an article or a tense is exactly what a reword changes, so the noun is
  // what the pattern pins.
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true]) {
          const state = { env, configured, canConnect, sandboxPatient };
          const said = invite(state);
          const where = JSON.stringify(state);
          assert.doesNotMatch(said.body, SPAN, where);
          if (said.action !== null) assert.doesNotMatch(said.action, SPAN, where);
        }
});
