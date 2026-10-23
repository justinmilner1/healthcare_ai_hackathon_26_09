import assert from "node:assert/strict";
import test from "node:test";
import { dexcomCardHint, dexcomConnectControl, DEXCOM_DEMO_LABEL, summaryDataInvite, type DexcomConnectControl, type DexcomHint } from "./dexcomHint";

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
  // A real visit on a sandbox deployment is offered the separate demonstration instead. T118 gave it this
  // button's words; it is a different offer and no longer wears them (T125, pinned as equalities below).
  assert.notEqual(invite({ configured: true }).action, "Connect Dexcom");
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
            // Something is on offer, and the button names the control the destination will actually
            // render: the real connection for `"oauth"`, the demonstration for `"demo"` (T125). Neither
            // may be sent to the patient in the other's words.
            assert.equal(said.action, control(state) === "oauth" ? "Connect Dexcom" : "Try the Dexcom demo", where);
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

// T125 (§2.5, §2.7, §9.2): `"oauth"` and `"demo"` are not one offer, and T118 left them sharing a branch
// on `control !== "none"`. The first imports this patient's own readings; the second opens a synthetic
// session of its own, which is all §13.4's sandbox deployment has for a real visit — so a real patient
// there was promised their own last week and sent to somebody's invented one.

const CONTROLS: DexcomConnectControl[] = ["oauth", "demo", "none"];

/** The demo invitation, written out once: both rows of the matrix below are this, for the reason there. */
const DEMO_INVITE = {
  body: "The Dexcom demo in Sweetie opens a separate synthetic-data session — synthetic readings, not your own. Your existing uploads stay unchanged.",
  action: "Try the Dexcom demo",
};

test("each control gets its own invitation, for both kinds of patient, as equalities (T125)", () => {
  const says = (c: DexcomConnectControl, sandboxPatient: boolean) => summaryDataInvite({ control: c, sandboxPatient });

  // `"oauth"` and `"none"` are what T118 left them, word for word — this ticket is only the third state.
  assert.deepEqual(says("oauth", false), {
    body: "Connect your Dexcom export and Sweetie will turn your readings into a clear picture for you and your doctor.",
    action: "Connect Dexcom",
  });
  assert.deepEqual(says("oauth", true), {
    body: "Connect Dexcom sandbox in Sweetie to import synthetic demo readings.",
    action: "Connect Dexcom",
  });
  assert.deepEqual(says("none", false), {
    body: "Share your Dexcom export in Sweetie and it will turn your readings into a clear picture for you and your doctor.",
    action: "Upload your Dexcom export",
  });
  assert.deepEqual(says("none", true), { body: "This demonstration visit has no synthetic readings in it.", action: null });

  // The new state. `sandboxPatient` cannot be true alongside `"demo"` — `dexcomConnectControl` reaches it
  // for a real visit only — and the copy would not read it if it could, because what this state turns on is
  // where the button leads and not whose record it sits on. Both rows are pinned so the unreachable one
  // cannot be given a sentence nobody looked at.
  assert.deepEqual(says("demo", false), DEMO_INVITE);
  assert.deepEqual(says("demo", true), DEMO_INVITE);

  // The regression itself: a demo link is not the Connect Dexcom offer. A branch folded back onto
  // `control !== "none"` fails here whatever the two sentences then say.
  assert.notDeepEqual(says("demo", false), says("oauth", false));
  assert.notDeepEqual(says("demo", false), says("none", false));
});

test("the demo invitation makes the destination's promise, not one about the patient's own data (T125)", () => {
  const said = summaryDataInvite({ control: "demo", sandboxPatient: false });
  assert.ok(said.action, "the demo link is a destination, so this state has a button");
  // One state, one promise — T118's rule for `"none"`, applied to `"demo"`. The destination for this state
  // is the demo link on /s/<token>, and the sentence under its card is dexcomCardHint's sandbox branch.
  const destination = hint({ configured: true });
  assert.equal(control({ configured: true }), "demo", "this is the state the two surfaces share");
  for (const phrase of ["a separate synthetic-data session", "Your existing uploads stay unchanged."]) {
    assert.ok(destination.includes(phrase), `the destination says: ${phrase}`);
    assert.ok(said.body.includes(phrase), `so does the invitation: ${phrase}`);
  }
  // And not the real-visit sentence, which promises this patient's own readings turned into a picture.
  assert.doesNotMatch(said.body, /turn your readings into a clear picture/);
  assert.doesNotMatch(said.body, /\bConnect Dexcom\b/);
  assert.doesNotMatch(said.action, /\bConnect Dexcom\b/);
  assert.match(said.body, /synthetic/, "the patient is told the readings are invented");
});

test("the demo link's own button keeps the invitation's promise (T134)", () => {
  // The last surface of this promise, and the one the patient reaches after the invitation: both labels on
  // `components/DexcomDemoLink.tsx`. They are pinned as equalities so a reword of either is a failure here
  // rather than a drift the patient finds by pressing the thing.
  assert.deepEqual({ ...DEXCOM_DEMO_LABEL }, { full: "Try the Dexcom demo", compact: "Dexcom demo" });

  // The full label is the invitation's button to the word — one phrase, two surfaces, so the state that
  // sent the patient here cannot name an action the destination does not offer (T118's rule, T125's state).
  const invite = summaryDataInvite({ control: "demo", sandboxPatient: false });
  assert.equal(DEXCOM_DEMO_LABEL.full, invite.action);
  // The compact one is the intake step's tight slot, so it may be shorter — but it is the same subject out
  // of the same place, not a second description of the thing.
  assert.ok(invite.action?.includes(DEXCOM_DEMO_LABEL.compact), "the short label is the long one's subject");

  for (const [slot, label] of Object.entries(DEXCOM_DEMO_LABEL)) {
    // "Try Dexcom sandbox" said which Dexcom an operator pointed this deployment at, to a real patient who
    // is never told that (T71): every patient on §13.4's sandbox deployment reaches this state.
    assert.doesNotMatch(label, /\bsandbox\b/i, slot);
    assert.doesNotMatch(label, OPERATOR, slot);
    // And "Connect Dexcom · Demo" made the claim this state has none of: no readings of this patient's own
    // are coming, which is the reason `summaryDataInvite` gives for not saying it either.
    assert.doesNotMatch(label, /\bConnect Dexcom\b/, slot);
    assert.match(label, /demo/i, `${slot} names the demonstration`);
  }

  // The synthetic demonstration patient's own copy is the other side of the T71 rule and is untouched: for
  // the patient the sandbox account *is*, the word describes who they are rather than an operator's
  // choice. So `OPERATOR` does not gain it, and that sentence keeps it.
  assert.doesNotMatch("sandbox", OPERATOR);
  assert.match(summaryDataInvite({ control: "oauth", sandboxPatient: true }).body, /\bsandbox\b/);
});

test("the new state is held to the same two rules as every other (T71's and T123's)", () => {
  // The matrices above reach these through `dexcomConnectControl`, which cannot produce `"demo"` with a
  // synthetic patient. Driving `summaryDataInvite` directly covers that row too, so the unreachable
  // sentence is under the rules as well: no operator fact in patient copy (T71), and no span named on the
  // one state of this page with no data to take one from (T123).
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  for (const c of CONTROLS)
    for (const sandboxPatient of [false, true]) {
      const said = summaryDataInvite({ control: c, sandboxPatient });
      const where = `${c}/${sandboxPatient}`;
      assert.ok(said.body.length > 0, `every state has a sentence: ${where}`);
      assert.doesNotMatch(said.body, OPERATOR, where);
      assert.doesNotMatch(said.body, SPAN, where);
      if (said.action !== null) {
        assert.doesNotMatch(said.action, OPERATOR, where);
        assert.doesNotMatch(said.action, SPAN, where);
      }
    }
});

// T132 (§2.5, §2.7): the same sweep T123 gave `summaryDataInvite` above, over `dexcomCardHint`'s
// unimported states — the ones that describe a file the patient has not sent yet. The unconfigured branch
// told them it would hold "your last 7 days of glucose", which is a presumption about their own export:
// Clarity sends whatever range they pick, `parseClarityCsv` keeps every EGV row it is handed, and
// data/fixtures/clarity_window.csv is 84 readings inside one morning.

/**
 * The one hint in this module that may name a span, written out so the sweep below can exclude it *by
 * name* rather than by a pattern that happens to miss it.
 *
 * `lib/dexcom.ts` requests `{ start: Math.max(first, end - 7 * 86400000), end }` (pinned by
 * lib/dexcom.test.ts), so on the OAuth branch the seven days are a fact about what the connection fetches,
 * not a guess about what the patient will upload. That is the rule T132 settled: name a span the system
 * controls, never one the patient chooses.
 *
 * Asserted as an equality, so a reword of this sentence fails here and has to be read against that rule
 * again. A `doesNotMatch` with this branch skipped would let it drift into any span at all.
 */
const OAUTH_WINDOW = "Authorize on Dexcom and return here. Your last 7 days of readings are imported.";

test("no hint for an unsent file names a span, and the one that may is the connection's own window (T132)", () => {
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  // The exclusion has to be doing real work: if this sentence stopped naming a span, the `assert.equal`
  // below would be the only thing still holding it, and a reader would have no way to see that the sweep
  // had gone slack. So the premise is checked rather than assumed.
  assert.match(OAUTH_WINDOW, SPAN, "the excluded branch is excluded because it names a span");

  let reachedOauth = 0;
  for (const env of ["sandbox", "production"] as const)
    for (const configured of [false, true])
      for (const canConnect of [false, true])
        for (const sandboxPatient of [false, true])
          for (const uploaded of [false, true]) {
            // `imported` is false throughout: an OAuth import's hint is its own date range, which is the
            // range that actually arrived and the one span on this card that was never in question.
            const state = { env, configured, canConnect, sandboxPatient, uploaded, imported: false, importRange: null };
            const said = hint(state);
            const where = JSON.stringify({ env, configured, canConnect, sandboxPatient, uploaded });
            assert.ok(said.length > 0, `every state has a hint: ${where}`);
            // The real-OAuth branch, named by the condition that reaches it in dexcomCardHint rather than
            // by the words it returns: nothing shared, credentials present, this visit may connect, and a
            // real patient rather than a synthetic one (whose import is invented and says so instead).
            if (configured && canConnect && !uploaded && !sandboxPatient) {
              assert.equal(said, OAUTH_WINDOW, where);
              reachedOauth += 1;
              continue;
            }
            assert.doesNotMatch(said, SPAN, where);
          }
  // And the branch is reachable, so the sweep is not quietly excluding a state it never visits.
  assert.equal(reachedOauth, 2, "the real-OAuth branch is reached on both deployments");
});
