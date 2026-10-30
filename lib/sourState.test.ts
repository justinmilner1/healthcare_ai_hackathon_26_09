// Unit tests for what the provider page says about a summary (T15, design §7.2).
//
// This walks one job through the transitions a clinician actually watches — queued, the first attempt, a
// failure that will be retried, the backoff wait, giving up, the retry that works — and asserts on the three
// things the page does with each: the word in the chip, whether the reason is in front of the clinician, and
// whether Generate is offered, withheld, or replaced by Retry.
//
// `visitNotStarted` at the bottom is the other decision the same two surfaces make from the same bundle
// (T148): not where a summary got to, but whether there is anything to show at all.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askSourClosedNote,
  askSourPlaceholder,
  askSourSubheading,
  emptyNarrativeText,
  narrativeNote,
  summaryListHeading,
  summaryState,
  visitNotStarted,
  waitingOnPatientNote,
} from "./sourState";
import type { SourJobState } from "./types";

const JOB: SourJobState = {
  id: "job_1",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  runAfter: "2026-10-11T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-10-11T12:00:00.000Z",
};

const job = (patch: Partial<SourJobState> = {}): SourJobState => ({ ...JOB, ...patch });
const view = (j: SourJobState | null, over: { hasSummary?: boolean; stale?: boolean; summaryAt?: string | null } = {}) =>
  summaryState({ job: j, hasSummary: false, stale: false, summaryAt: null, ...over });

describe("summaryState", () => {
  it("has nothing to report before anyone has run Sour", () => {
    const s = view(null);
    assert.equal(s.phase, "none");
    assert.equal(s.label, "Not generated");
    assert.equal(s.busy, false, "Generate is the whole point of this state");
    assert.equal(s.canRetry, false);
    assert.equal(s.at, null);
  });

  it("says queued while the job waits for the runner, and holds Generate shut", () => {
    const s = view(job());
    assert.equal(s.phase, "queued");
    assert.equal(s.label, "Queued");
    assert.equal(s.busy, true, "a second run would be the same work twice");
    assert.equal(s.canRetry, false);
    assert.equal(s.at, null, "there is no backoff to wait out on a first attempt");
  });

  it("says running, with the attempt and when it started", () => {
    const s = view(job({ status: "running", attempts: 1, startedAt: "2026-10-11T12:00:05.000Z" }));
    assert.equal(s.phase, "running");
    assert.equal(s.label, "Running");
    assert.match(s.detail, /Attempt 1 of 3/);
    assert.equal(s.at, "2026-10-11T12:00:05.000Z");
    assert.equal(s.busy, true);
  });

  it("puts the reason in front of the clinician while a retry is still waiting out its backoff", () => {
    // A job between attempts is `queued` again, and "Queued" on its own would hide the one thing worth
    // reading: the error that is about to be retried.
    const s = view(job({ attempts: 1, lastError: "Error: the model gateway did not respond", runAfter: "2026-10-11T12:01:00.000Z" }));
    assert.equal(s.phase, "queued");
    assert.match(s.detail, /Attempt 2 of 3/);
    assert.match(s.detail, /model gateway did not respond/);
    assert.equal(s.at, "2026-10-11T12:01:00.000Z", "the clinician can see when it comes due");
    assert.equal(s.busy, true);
    assert.equal(s.canRetry, false, "the queue is already going to retry this one");
  });

  it("names the failure and offers the retry once the attempts are spent", () => {
    const s = view(job({ status: "failed", attempts: 3, lastError: "Error: visit not found", finishedAt: "2026-10-11T12:06:00.000Z" }));
    assert.equal(s.phase, "failed");
    assert.equal(s.label, "Failed");
    assert.match(s.detail, /visit not found/);
    assert.match(s.detail, /3 of 3 attempts/);
    assert.equal(s.canRetry, true);
    assert.equal(s.busy, false, "nothing is coming unless the clinician asks");
    assert.equal(s.at, "2026-10-11T12:06:00.000Z");
  });

  it("still offers the retry when a job failed without recording why", () => {
    const s = view(job({ status: "failed", attempts: 3 }));
    assert.equal(s.canRetry, true);
    assert.match(s.detail, /No reason was recorded/);
  });

  it("reads ready once the job is done and the summary is on screen", () => {
    const s = view(job({ status: "done", attempts: 1, finishedAt: "2026-10-11T12:00:30.000Z" }), { hasSummary: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "ready");
    assert.equal(s.label, "Ready");
    assert.equal(s.at, "2026-10-11T12:00:29.000Z", "the summary's time, not the job's");
    assert.equal(s.busy, false);
    assert.equal(s.canRetry, false);
  });

  it("reads out of date when the patient has added data since the summary (§7.1)", () => {
    const s = view(job({ status: "done", attempts: 1 }), { hasSummary: true, stale: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "stale");
    assert.equal(s.label, "Out of date");
    assert.match(s.detail, /regenerate to include them/i);
    assert.equal(s.busy, false, "Regenerate must be reachable: that is the whole suggestion");
  });

  it("lets a job in flight outrank the summary already on screen", () => {
    for (const status of ["queued", "running"] as const) {
      const s = view(job({ status, attempts: 1 }), { hasSummary: true, stale: true, summaryAt: "2026-10-11T12:00:29.000Z" });
      assert.equal(s.busy, true, `${status} means something is still coming`);
      assert.notEqual(s.phase, "stale", `${status} is more useful than "regenerate" advice`);
    }
  });

  it("reports a summary with no job at all, which is how a reused one reads after a reload", () => {
    const s = view(null, { hasSummary: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "ready");
    assert.equal(s.at, "2026-10-11T12:00:29.000Z");
  });

  it("does not claim a summary is ready when the job finished without writing one", () => {
    const s = view(job({ status: "done", attempts: 1 }));
    assert.equal(s.phase, "none");
    assert.equal(s.canRetry, false);
  });

  it("falls back to the job's own ceiling rather than hardcoding three", () => {
    const s = view(job({ status: "running", attempts: 2, maxAttempts: 5, startedAt: "2026-10-11T12:00:05.000Z" }));
    assert.match(s.detail, /Attempt 2 of 5/);
  });
});

// T63 (design §6.3, §11.3): the other half of that strip — why a summary that is Ready has no narrative in
// it. The claim worth a test is not the prose, it is that neither sentence is an ops instruction: the patient
// reads a version of this screen (§2.7), and the clinician cannot set an environment variable from the room.
describe("narrativeNote", () => {
  it("says nothing about a narrative the model wrote", () => {
    assert.equal(narrativeNote(undefined), null);
  });

  it("tells a configured-but-unreachable gateway apart from a deployment with no model", () => {
    assert.match(narrativeNote("unavailable")!, /retry in a minute/i);
    assert.doesNotMatch(narrativeNote("unconfigured")!, /retry/i, "nobody at the practice can retry their way to a key");
    assert.match(narrativeNote("unconfigured")!, /not configured/i, "the state is the point: no model was asked");
  });

  // T96: T63 swapped a variable name for a person and went one step too far, inventing the control that
  // person would use. `Practice` has three settable fields and none of them is an assistant, so a note
  // pointing at a practice role sends the clinician to Settings for something that is not there and the
  // admin to a switch that exists nowhere in the product.
  it("offers no practice-level remedy for a model the practice cannot configure", () => {
    const note = narrativeNote("unconfigured")!;
    assert.doesNotMatch(note, /administrator|\badmin\b/i, `names a practice role: ${note}`);
    assert.doesNotMatch(note, /turn it on|enable|enabled|switch it on/i, `invents a control: ${note}`);
    assert.doesNotMatch(note, /for this practice|your practice/i, `makes it the practice's setting: ${note}`);
    // The one person who can actually act, in the words lib/delivery.ts already uses for a sender nobody
    // has configured — so staff read the same phrase whichever thing the deployment is missing.
    assert.match(note, /ask whoever set Sweet Spot up for your office/, note);
    assert.match(note, /no practice setting/i, "and says outright that Settings is not where to look");
  });

  it("never names a variable, a key, or whoever deploys the app", () => {
    for (const missing of ["unavailable", "unconfigured"] as const) {
      const note = narrativeNote(missing)!;
      assert.doesNotMatch(note, /OPENAI|API_KEY|api key|env|\.env|variable|deploy/i, `${missing}: ${note}`);
      assert.match(note, /the numbers are complete/, `${missing} must say the numbers still stand`);
      // The screen puts this above the numbers and the printed sheet below them, so it cannot point.
      assert.doesNotMatch(note, /\babove\b|\bbelow\b/i, `${missing} must read the same in both places`);
    }
  });

  it("does not let an empty Patterns list claim Sour looked and found nothing", () => {
    assert.equal(emptyNarrativeText(undefined, "None found."), "None found.");
    assert.equal(emptyNarrativeText("unconfigured", "None found."), "Not generated.");
    assert.equal(emptyNarrativeText("unavailable", "None."), "Not generated.");
  });
});

// T148, design §2.6 and §2.5. The predicate the clinician's two surfaces branch on, and the bug it had:
// a check-in the safety scan stopped on the patient's first message wraps with every field still
// `unfilled`, so `answered` is 0 — and without `wrapped` in the predicate both surfaces called that visit
// empty while a brief was saved for it and the clinician had been emailed a link to read it.
describe("visitNotStarted", () => {
  const not = (over: { wrapped?: boolean; answered?: number; hasDexcom?: boolean } = {}) =>
    visitNotStarted({
      intake: { wrapped: over.wrapped ?? false },
      status: { answered: over.answered ?? 0, hasDexcom: over.hasDexcom ?? false },
    });

  it("is the card's own case: booked, invited, and nothing has come back", () => {
    assert.equal(not(), true, "no answer, no glucose, no wrap — the one state with nothing to render");
  });

  it("is false for a wrap the safety scan stopped before a single field was filled", () => {
    // The T148 case, measured on the visit e2e/flows.spec.ts books as `E2E Flagged`: flagged on the first
    // message, two turns, both fields `unfilled`, nothing uploaded, and two Summary rows saved.
    assert.equal(not({ wrapped: true }), false, "a flagged wrap has a brief: the flag and the patient's own words");
  });

  it("is false for every other wrap, with or without glucose", () => {
    // A skip sets `questionsSkipped` *and* `wrapped` (lib/sweetie.ts), so it is covered by the same flag.
    assert.equal(not({ wrapped: true, answered: 1 }), false);
    assert.equal(not({ wrapped: true, hasDexcom: true }), false);
    assert.equal(not({ wrapped: true, answered: 2, hasDexcom: true }), false);
  });

  it("is false as soon as the patient has said or shared anything, wrap or no wrap", () => {
    assert.equal(not({ answered: 1 }), false, "mid-interview: one answer is a brief worth writing");
    assert.equal(not({ hasDexcom: true }), false, "readings with no conversation are still readings");
  });
});

// T153, design §2.6 and §7.5. The one element of the brief that did not read `bundle.status`: the composer's
// placeholder named both exports on every visit, including the one whose own notice four elements above says
// there is no glucose. All four combinations are pinned, because the bug was a constant and a constant passes
// any one of them.
describe("askSourPlaceholder", () => {
  const ph = (hasDexcom: boolean, hasWhoop: boolean) => askSourPlaceholder({ hasDexcom, hasWhoop });

  it("offers both sources when the visit has both", () => {
    assert.equal(ph(true, true), "Ask about the glucose spikes or sleep data…");
  });

  it("does not offer sleep data beside a Sleep card reading \"No sleep data.\"", () => {
    const text = ph(true, false);
    assert.doesNotMatch(text, /sleep/i, text);
    assert.match(text, /glucose/i, text);
  });

  it("does not offer glucose on a brief that has just said there is none", () => {
    // The `desktop-provider-sour-conversation-only.png` case, and the WHOOP-only one beside it: a suggested
    // question about data the visit does not have is one Sour can only answer with "there is no glucose
    // data", and §7.5 keeps that exchange on the visit for the practice to read.
    for (const text of [ph(false, true), ph(false, false)]) {
      assert.doesNotMatch(text, /glucose/i, text);
    }
    assert.match(ph(false, true), /sleep/i);
  });

  it("points at what the patient said when there is no upload to point at", () => {
    const text = ph(false, false);
    assert.match(text, /patient said/i, text);
    assert.doesNotMatch(text, /glucose|sleep|upload|file/i, text);
  });

  it("reads as a prompt for a question in every combination", () => {
    for (const [d, w] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const text = ph(d, w);
      assert.match(text, /^Ask about .+…$/u, `${d}/${w}: ${text}`);
    }
  });
});

// T195 (design §7.5, §6.3, §2.6): T153 one step out. The placeholder above decides what the box may be
// asked about; these two decide whether it may be asked at all. The three states are the point — the
// composer is withdrawn on exactly one of them, because only one of them is a state a press can never get
// out of, and a press is not free: §7.5 logs the question before the model is asked and §10.2 audits it.
describe("askSourClosedNote", () => {
  it("leaves the composer alone on a deployment whose model wrote the narrative", () => {
    assert.equal(askSourClosedNote(undefined), null);
  });

  it("leaves the composer alone for a gateway that is merely down", () => {
    // T63's half: "unavailable" clears on its own, so a retry is the right thing to offer and the control
    // has to still be there to retry with.
    assert.equal(askSourClosedNote("unavailable"), null);
  });

  it("withdraws it where no model is configured, and says which state that is", () => {
    const note = askSourClosedNote("unconfigured")!;
    assert.ok(note, "an unconfigured deployment gets a sentence in place of the control");
    assert.match(note, /not configured/i, `the state is the point: ${note}`);
    // It cannot tell anyone to try again: this is the state that a retry does not reach, which is the whole
    // reason the control goes away here and stays for the sibling above.
    assert.doesNotMatch(note, /retry|try again|again in a minute/i, `invites a retry that cannot work: ${note}`);
  });

  it("agrees with the caveat at the top of the same brief instead of restating it", () => {
    const note = askSourClosedNote("unconfigured")!;
    // Same lede as narrativeNote's, so a clinician reads one state and not two (they are four cards apart
    // on the brief).
    assert.match(note, /^Assistant not configured:/, note);
    // And not the whole of it again: the remedy is the caveat's sentence, and this one is about the control.
    assert.doesNotMatch(note, /ask whoever set Sweet Spot up/i, `repeats the caveat: ${note}`);
    assert.doesNotMatch(note, /the numbers are complete/i, `repeats the caveat: ${note}`);
  });

  it("names no variable and invents no practice setting (T96)", () => {
    const note = askSourClosedNote("unconfigured")!;
    assert.doesNotMatch(note, /OPENAI|API_KEY|api key|env|\.env|variable|deploy/i, note);
    assert.doesNotMatch(note, /administrator|\badmin\b|turn it on|enable|enabled|switch it on/i, `invents a control: ${note}`);
    assert.doesNotMatch(note, /for this practice|your practice|settings/i, `sends the reader to Settings: ${note}`);
  });

  it("is one sentence, like the caveat it sits under", () => {
    const note = askSourClosedNote("unconfigured")!;
    assert.equal(note.split(/(?<=\.)\s+/).length, 1, `more than one sentence: ${note}`);
  });
});

describe("askSourSubheading", () => {
  it("offers the subject on every deployment that can answer", () => {
    for (const missing of [undefined, "unavailable"] as const) {
      const text = askSourSubheading(missing);
      assert.match(text, /^Ask about this patient’s data · /, `${missing}: ${text}`);
    }
  });

  it("stops inviting a question the card below it has just refused", () => {
    const text = askSourSubheading("unconfigured");
    assert.doesNotMatch(text, /^Ask about/, `the heading invites what the body refuses: ${text}`);
  });

  it("keeps §7.5's promise about the log in all three states, because the rows stay in all three", () => {
    for (const missing of [undefined, "unavailable", "unconfigured"] as const) {
      const text = askSourSubheading(missing);
      assert.match(text, /kept with the visit and shown to this practice/, `${missing}: ${text}`);
    }
  });
});

describe("summaryListHeading", () => {
  // The sidebar's rows, in the shapes `visible` in app/provider/[id]/sour.tsx can take: every visit with a
  // summary, plus the selected one whether or not it has one.
  const rows = (...hasSummary: boolean[]) => hasSummary.map((h) => ({ hasSummary: h }));

  it("claims readiness when every row in the list is ready", () => {
    assert.equal(summaryListHeading(rows(true, true, true)), "Summaries ready");
    assert.equal(summaryListHeading(rows(true)), "Summaries ready");
  });

  it("does not claim a summary for the selected visit that has none", () => {
    // The `provider-sour-not-started` case: the dashboard's Summarize button lands here, so the visit you
    // are looking at is in the list without a summary while the others have one. The heading accounts for
    // it in words instead of leaving it to the missing tick.
    const text = summaryListHeading(rows(false, true, true, true));
    assert.notEqual(text, "Summaries ready", "one row in this list has no summary");
    assert.match(text, /this visit/i, text);
  });

  it("still names the ready ones when they are in the list beside it", () => {
    assert.equal(summaryListHeading(rows(false, true)), "This visit · summaries ready");
  });

  it("says only what is there when the selected visit is alone and unsummarized", () => {
    const text = summaryListHeading(rows(false));
    assert.equal(text, "This visit");
    assert.doesNotMatch(text, /summar/i, "nothing in this list is summarized");
  });

  it("claims nothing over an empty list", () => {
    // The sentence at the foot of the list already says "No summaries yet."; the heading just stops
    // contradicting it.
    const text = summaryListHeading([]);
    assert.doesNotMatch(text, /ready/i, text);
    assert.equal(text, "Summaries");
  });

  it("is the bare claim only when the whole list earns it, whatever the order", () => {
    // The property the ticket is actually about: "Summaries ready" on its own is a statement about every
    // row, so it may be the whole heading only when every row has a summary. Row order cannot change that,
    // and a list with one unsummarized row reads the same wherever that row sits.
    for (const shape of [[], [true], [false], [true, false], [false, true], [true, true], [false, true, true], [true, false, true]]) {
      const text = summaryListHeading(rows(...shape));
      const allReady = shape.length > 0 && shape.every(Boolean);
      assert.equal(text === "Summaries ready", allReady, `${JSON.stringify(shape)}: ${text}`);
    }
    assert.equal(summaryListHeading(rows(true, false, true)), summaryListHeading(rows(false, true, true)));
  });
});

// T183 (design §2.3, §2.6, §5.3, §7.4, §8.1): the sentence that closes the same two surfaces' "waiting on
// the patient" block. Both directions, because the bug was a static literal and a literal satisfies
// whichever one of the two you assert on its own — which is exactly how this line survived T140, T168,
// T170, T173, T175, T177 and T179 taking the same claim off the other six surfaces.
describe("waitingOnPatientNote", () => {
  const CAN = waitingOnPatientNote(true);
  const CANNOT = waitingOnPatientNote(false);

  it("keeps the instruction, to the word, where the link can open", () => {
    // Criterion 3: that direction is right and must not move. Pinned verbatim, since this is the string the
    // two surfaces printed before the fix and the one a reachable patient's office still has to read.
    assert.equal(CAN, "Send the link again if they have not opened it.");
  });

  it("withdraws it where no code can reach the patient", () => {
    assert.match(CANNOT, /^Sending the link again will not/, "the instruction above it, taken back");
    assert.doesNotMatch(CANNOT, /^Send the link again/);
    assert.notEqual(CANNOT, CAN);
  });

  it("states one thing and offers no remedy of its own (the T170 split)", () => {
    // The dashboard row owns the visit's contact details and therefore the fix (`NO_CODE_CAN_REACH`,
    // lib/delivery.ts: "— call them"). The brief and the sheet state the consequence and stop.
    assert.doesNotMatch(CANNOT, /call them|telephone|add a phone|add an email|Copy intake/i);
    // Nor the invite note's own clause one element above it (`NO_HANDOVER_SENTENCE`): nothing on this card
    // ever offered to hand the link over, so there is no offer here to take back.
    assert.doesNotMatch(CANNOT, /hand(?:ing)? the link over/i);
    // Nor `narrativeNote`'s subject, which is a different gap in a different deployment.
    assert.doesNotMatch(CANNOT, /patterns and questions|gateway|Assistant not configured/i);
  });

  it("names no variable, backend or administrator (§3.7, §10.6)", () => {
    for (const note of [CAN, CANNOT]) {
      assert.doesNotMatch(note, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
      assert.doesNotMatch(note, /whoever set|administrator|environment/i);
    }
  });

  it("is one sentence either way, for the slot both surfaces put it in", () => {
    // The lead sentence differs between the brief and the sheet; this one follows it, so it starts with a
    // capital and ends on a full stop and holds no second sentence of its own.
    for (const note of [CAN, CANNOT]) {
      assert.match(note, /^[A-Z][^.]*\.$/, note);
    }
  });
});
