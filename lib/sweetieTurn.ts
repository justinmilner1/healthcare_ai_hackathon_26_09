// One turn of Sweetie's conversation, and design §6.2: "Every patient message is stored before any model
// call; the transcript survives a crash."
//
// Both halves of that sentence are about *order*, which is the one thing reading a route cannot prove. So the
// order lives here instead, behind two ports the caller supplies — a `TurnStore` that talks to Postgres and a
// `TurnModel` that talks to the gateway — and app/api/sweetie/route.ts is left as transport. lib/sweetieTurn.test.ts
// drives this with a store that records the order it was called in and a model that can be told to throw, so
// "before any model call" is asserted rather than read, and a crash in the middle of a turn is a test rather
// than an incident.
//
// The two invariants, stated once:
//
//   1. `store.append("patient", …)` resolves before `model.extract` or `model.speak` is called. A crash after
//      that point therefore still leaves the patient's words on the visit.
//   2. Sweetie's reply and the intake state reach the database together, in `store.commit`, or not at all. A
//      half-written turn — a question the patient can read with the state it came from missing, or an intake
//      that has moved on with nothing on screen to show why — is what §6.2's "consistent" rules out.

import { backstop, extract, merge, nextTarget, redFlagReply, scanRedFlags, scripted, speak, LLMUnavailable } from "./sweetie";
import type { Target, VisitContext } from "./sweetie";
import type { ChatRole, IntakeFieldDef, IntakeState, IntakeStatus } from "./types";

/** Sweetie asks at most this many questions before she wraps up, however little has been filled in. */
export const MAX_TURNS = 6;

/** Everything a turn needs from the database. The implementations are in the route; the fakes are in the test. */
export type TurnStore = {
  /** Append one message to the visit's transcript. Must be committed by the time this resolves (§6.2). */
  append(role: ChatRole, content: string): Promise<void>;
  /** The transcript so far, oldest first, as the model reads it. */
  transcript(): Promise<string>;
  /** What the patient has actually uploaded (lib/bundle.ts), which is half of what decides the next question. */
  status(): Promise<IntakeStatus>;
  /** Sweetie's reply and the state it was written from, in one transaction. All of it or none of it. */
  commit(reply: string, state: IntakeState): Promise<void>;
};

/** The two model calls a turn can make, injectable so a test can make either one fail or hang. */
export type TurnModel = {
  extract: typeof extract;
  speak: typeof speak;
};

/** The real gateway (lib/llm.ts through lib/sweetie.ts). */
export const liveModel: TurnModel = { extract, speak };

export type ExportHelp = "dexcom" | "timeline" | "whoop" | null;
export type UploadEvent = { kind: string; count: number; days?: number };

export type TurnInput = {
  /** What the patient typed or said, already trimmed. Absent on an upload-only turn. */
  message?: string;
  /** An upload the page is telling Sweetie about, so she can acknowledge what arrived. */
  event?: UploadEvent;
  /** The state this turn starts from, parsed from `Visit.intake`. */
  state: IntakeState;
  defs: IntakeFieldDef[];
  visit: VisitContext;
  firstName: string;
  providerName: string;
};

export type TurnResult = {
  /** The state as committed. The caller re-reads the bundle rather than trusting this for display. */
  state: IntakeState;
  reply: string;
  /** True when the words came from `scripted` instead of the model (design §6.3). */
  fellBack: boolean;
  /** Which model call fell back first, for the route's one log line. */
  fallbackAt: "extract" | "speak" | null;
  /** What the turn ended up aiming at, after the MAX_TURNS cap. */
  target: Target;
  /** The red-flag id, when the deterministic scan fired and the turn stopped there. */
  flagged: string | null;
};

/**
 * Run one turn: store what the patient said, work out what it told us, and say the next thing.
 *
 * The sequence is the contract. A patient message is appended first and on its own, so that every later step
 * — the safety scan, two model calls, the commit — happens with the patient's words already durable. Nothing
 * between that append and the final commit writes to the database, which is what makes a crash in the middle
 * of a turn leave the visit exactly as it was plus one patient message: on reload the patient sees what they
 * said, the stepper reads the state it read before, and the next message re-runs the turn.
 */
export async function runTurn(input: TurnInput, store: TurnStore, model: TurnModel = liveModel): Promise<TurnResult> {
  const { defs, visit, firstName, providerName: provider } = input;
  let state = input.state;

  // 1. The patient's words, before anything else can fail. §6.2's first half is this line's position.
  if (input.message) {
    await store.append("patient", input.message);
    state = { ...state, turns: state.turns + 1 };

    // 2. Safety is deterministic and comes before any model call, so a gateway that is down cannot swallow it.
    const flag = scanRedFlags(input.message);
    if (flag) {
      state = { ...state, flagged: flag, wrapped: true };
      const reply = redFlagReply(firstName, provider);
      await store.commit(reply, state);
      return { state, reply, fellBack: false, fallbackAt: null, target: { kind: "wrap" }, flagged: flag };
    }
  }

  const transcript = await store.transcript();

  // 3. What was Sweetie asking? Decided from the state as it was when she asked, so the extractor and the
  //    backstop both know which field this answer belongs to.
  const askedTarget = nextTarget(state, defs);
  const askedId = askedTarget.kind === "field" ? askedTarget.def.id : null;

  let fallbackAt: TurnResult["fallbackAt"] = null;
  let exportHelp: ExportHelp = null;

  // 4. Extract what the latest message tells us (model), then the deterministic backstop behind it.
  if (input.message) {
    try {
      const ex = await model.extract(state, defs, transcript, input.message, askedId);
      state = merge(state, ex);
      exportHelp = ex.asks_export_help;
      state = noteDecline(state, askedTarget, input.message);
    } catch (e) {
      // A gateway that is unavailable is a path the design plans for (§6.3). Anything else is a bug, and is
      // allowed to escape: the patient's message is already stored, nothing else has been written, and a
      // half-finished turn must not be committed as if it had worked.
      if (!(e instanceof LLMUnavailable)) throw e;
      fallbackAt = "extract";
      exportHelp = guessExportHelp(input.message);
      state = noteDecline(state, askedTarget, input.message);
    }
    state = backstop(state, askedId, input.message);
  }

  // 5. Direction, from the state. The upload status comes along for Sweetie's own words — what she already
  //    has, and what she should not ask for twice.
  const status = await store.status();
  let target = nextTarget(state, defs);
  if (state.turns >= MAX_TURNS && target.kind !== "wrap") target = { kind: "wrap" };

  // 6. Say it. The scripted path is the same targets in fixed words, so a gateway failure changes the
  //    wording and nothing else — including what gets stored.
  let reply: string;
  if (fallbackAt) {
    reply = scripted({ firstName, target, exportHelp, uploadEvent: input.event, isSandbox: visit.isSandbox });
  } else {
    try {
      reply = await model.speak({ firstName, providerName: provider, visit, state, defs, status, target, transcript, exportHelp, uploadEvent: input.event });
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      fallbackAt = "speak";
      reply = scripted({ firstName, target, exportHelp, uploadEvent: input.event, isSandbox: visit.isSandbox });
    }
  }
  if (target.kind === "wrap") state = { ...state, wrapped: true };

  // 7. One write, so there is no state in which the patient can read a question the intake has not caught up to.
  await store.commit(reply, state);
  return { state, reply, fellBack: fallbackAt !== null, fallbackAt, target, flagged: state.flagged };
}

/** A "no" to the data offer counts even when the extractor missed it, or never ran. */
function noteDecline(state: IntakeState, asked: Target, message: string): IntakeState {
  if (asked.kind !== "upload") return state;
  if (state.skipped.includes(asked.which)) return state;
  if (!/\b(no|not|rather not|don'?t|skip|pass)\b/i.test(message)) return state;
  return { ...state, skipped: [...state.skipped, asked.which] };
}

/** The extractor's `asks_export_help`, worked out from the words when there is no extractor to ask. */
export function guessExportHelp(text: string): ExportHelp {
  const t = text.toLowerCase();
  if (!/how|where|get|find|export|download/.test(t)) return null;
  if (/dexcom|clarity|glucose|cgm/.test(t)) return "dexcom";
  if (/timeline|maps|location/.test(t)) return "timeline";
  if (/whoop|sleep/.test(t)) return "whoop";
  return null;
}
