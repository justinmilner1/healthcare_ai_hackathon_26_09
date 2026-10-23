// The suite's machine-dependent budgets, in one place (T89, T95; docs/ROUTINES.md, "When the box is the
// problem"). Every number here is a ceiling for something that has stopped making progress, not an estimate
// of something healthy: how long a build, a page load or a drained queue takes is a property of the
// container and not of the tree. The 2026-10-10 probe measured a build at about 40s warm; runs since have
// measured the same build at 4m29s, 8m12s and 11m25s on idle 4-CPU sandboxes. So each budget is overridable
// for a run by one environment variable, and nothing in a spec may write a flat number the shared one can
// overtake — `npm run lint` says so.

/**
 * A millisecond budget from the environment, or `fallback` when it is absent, empty or not a positive number.
 *
 * `Number(process.env.X ?? d)` is not enough now that docs/ROUTINES.md tells a routine on a slow box to set
 * these (T89): `Number("")` is 0 and `Number("3min")` is NaN, and `??` catches neither, so one malformed
 * value would silently become a budget of zero or of nothing at all rather than the documented default.
 */
export const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How long one wait on asynchronous work may take before the suite calls it failed, in milliseconds.
 *
 * This is the budget behind every `LOADED` below — a client fetch painting, a `sour.run` draining, Sweetie's
 * opening transcript landing, an audit table filtering. It was a flat `const LOADED = { timeout: 30_000 }`
 * declared separately in twenty-one spec files and passed to 187 assertions, chosen on the box the
 * 2026-10-10 probe measured, and it is the budget most likely to blow on a slow one: the reviewer run of
 * 2026-10-19 measured the same no-op `sour.run` at 1.3s idle and 27.0s under contention, about 20x, against
 * a flat 20s poll (T95, #166).
 *
 * The failures that produced are the expensive kind, because they are not bare timeouts: a 30s `expect` wait
 * fails *inside* a 180s test, so Playwright reports the assertion and the last value it saw rather than the
 * clock. `print.spec.ts` read `data-phase` as `"none"` — which names the §7.1 enqueue path as broken —
 * `flows.spec.ts` read a summary as `"stale"`, `durability.spec.ts` read a transcript as `""`. Re-run
 * serially on the same tree, every one of them passed. That is also why raising `E2E_TEST_TIMEOUT_MS`, the
 * one override the documentation used to offer, could not reach any of them.
 *
 * Raising this past `E2E_TEST_TIMEOUT_MS` would be pointless: a wait cannot outlast the test holding it, so
 * a box slow enough to need a much larger budget here needs both.
 */
export const LOADED_TIMEOUT_MS = envMs("E2E_LOADED_TIMEOUT_MS", 30_000);

/** The budget above, as the options object a Playwright assertion or poll takes. */
export const LOADED = { timeout: LOADED_TIMEOUT_MS } as const;

/**
 * The same budget with a floor under it, for a wait that genuinely needs longer than an ordinary one.
 *
 * A floor, never a flat number, for the reason `uploads.spec.ts` writes its per-test timeout as one
 * (playwright.config.ts, `TEST_TIMEOUT_MS`): a shared ceiling that is raised can overtake a flat per-site
 * number, which hands the wait with the most to do the least headroom on exactly the slow box the override
 * was raised for.
 */
export const loadedAtLeast = (ms: number) => ({ timeout: Math.max(ms, LOADED_TIMEOUT_MS) });

/**
 * A wait for a job to be queued, picked up and finished — a `sour.run` writing a summary pair, a §10.5 purge
 * clearing a patient out of the dashboard (design §3.4, §7.1).
 *
 * Twice `LOADED`'s default, because it waits on the drain interval as well as the work: the runner has to
 * come round to the row before it can start on it. This is the one place that 60s is written.
 */
export const DRAINED = loadedAtLeast(60_000);

/**
 * How long a wait the suite expects to *run out* is given before it does (T124).
 *
 * Every budget above is a ceiling for something that has stopped making progress: a healthy run never
 * reaches it, so headroom there is free and a slow box is the only thing it is spent on. A handful of waits
 * in `e2e/transcript.spec.ts` are the other shape. They are staged on a condition that is never satisfiable
 * — a newest message parked below the fold for good, a transcript whose newest message is replaced faster
 * than any reading can confirm it — because the subject under test is `expectTranscriptUncut` giving up and
 * saying why. Those spend their whole budget on every run, on both projects, including the green ones.
 *
 * So a ceiling sized for a box twenty times slower than the probe's buys them nothing and costs the suite
 * that much wall time, six times over. What they need is not a ceiling at all but a floor: enough round
 * trips for the poll to observe the thing its failure message names — two readings of a changing newest
 * message, in the worst of them — and no more. A budget too small cannot turn a negative into a false pass
 * the way one too small turns a positive into a false failure, because the condition is false at every
 * reading whatever the box is doing; it can only rob the poll of the readings the message is made of.
 *
 * Hence a quarter of `LOADED`, with 8s under it. It is derived rather than written down so that
 * `E2E_LOADED_TIMEOUT_MS` — the override docs/ROUTINES.md tells a routine on a slow box to reach for —
 * reaches these waits too, which is the whole of what T124 is about: a budget the override cannot see is a
 * budget that fails as a verdict on the product. The floor keeps it sane if the shared budget is ever
 * lowered.
 */
export const GIVES_UP = { timeout: Math.max(8_000, Math.round(LOADED_TIMEOUT_MS / 4)) } as const;
