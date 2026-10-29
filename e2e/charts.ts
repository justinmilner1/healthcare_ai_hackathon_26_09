import { expect, test, type Locator, type Page } from "@playwright/test";
import { LOADED } from "./budget";

// T87 (design §2.6, §2.7, §7.4): what a chart tooltip reads, on each of the three surfaces a chart appears on.
//
// The separator between a tooltip's label and its value used to be Recharts' own default " : ", because
// nothing set it, so every tooltip in the product read "Glucose : 118 mg/dL". It is `TOOLTIP_SEPARATOR` in
// components/chartTooltip.ts now, and this is what stops it drifting back: a default nobody chose is exactly
// the kind of thing that returns when a fourth chart is added.

/** Recharts draws after it has measured itself, so this is the suite's wait on asynchronous work under the
 *  name this helper is about (e2e/budget.ts, T95). */
const DRAWN = LOADED;

/** The glucose line's tooltip row, in full: our separator, and the word and unit its formatter chooses. */
const GLUCOSE = /^Glucose: \d+ mg\/dL$/;
/**
 * The sleep columns'. The recovery suffix is required rather than optional, because it is the part of
 * this string the ticket promised to leave alone: every night in both WHOOP samples the suite uploads
 * carries a recovery score (data/whoop_sample.csv, data/fixtures/whoop_cycles.csv), so a tooltip here
 * without one would mean the suffix had been lost rather than that the data never had it.
 */
const ASLEEP = /^Asleep: \d+(\.\d+)? h · recovery \d+%$/;

/** The chart drawing a line, and the one drawing columns, whichever cards this page puts them in. */
const lineChart = (page: Page): Locator =>
  page.locator(".recharts-wrapper").filter({ has: page.locator(".recharts-line") }).first();
const barChart = (page: Page): Locator =>
  page.locator(".recharts-wrapper").filter({ has: page.locator(".recharts-bar") });

/**
 * Hover one chart and read back the single row of the tooltip it opens.
 *
 * `textContent` rather than `innerText`, because the separator is the whole subject: Recharts puts the name,
 * the separator and the value in three sibling spans, and the browser collapses the whitespace between them
 * on the way to rendered text — so `innerText` cannot tell " : " from ": ". The row is read inside its own
 * chart's wrapper, because a page with two charts has two tooltips and the one the pointer has just left is
 * still in the document.
 */
async function tooltipRow(page: Page, chart: Locator): Promise<string> {
  // From a corner first: Recharts opens the tooltip on a mouse *move*, and a pointer already sitting where
  // the next hover would put it produces no move at all.
  await page.mouse.move(0, 0);
  await chart.locator(".recharts-surface").hover();
  const row = chart.locator(".recharts-tooltip-item").first();
  await expect(row, "hovering the chart opens its tooltip").toBeVisible(DRAWN);
  return (await row.textContent()) ?? "";
}

/**
 * Every chart on whichever surface the caller is standing on, read by its tooltip.
 *
 * Desktop only. §6.5's 375px device has no pointer to hover with, so there is no tooltip there to read — the
 * same reason e2e/demo.spec.ts gives for not reading a `title` attribute at that width. `photograph` is run
 * once per chart with that chart's tooltip still open, for a caller that wants the picture as well as the
 * assertion (§12.3); it is not run on the phone, where the state it would be photographing does not exist.
 */
export async function expectChartTooltipsLabelled(
  page: Page,
  where: string,
  photograph?: (chart: "sleep" | "glucose") => Promise<void>,
): Promise<void> {
  if (test.info().project.name !== "desktop") return;

  const bars = barChart(page);
  if (await bars.count()) {
    expect(await tooltipRow(page, bars.first()), `${where}: the sleep tooltip`).toMatch(ASLEEP);
    await photograph?.("sleep");
  }
  // The chart all three surfaces have, and the one the ticket was reported against.
  expect(await tooltipRow(page, lineChart(page)), `${where}: the glucose tooltip`).toMatch(GLUCOSE);
  await photograph?.("glucose");
}

// T187 (design §2.6, §2.7, §7.4, §6.5): and what is written under the glucose line, on the same three
// surfaces. A chart whose readings all fell inside one calendar day drew an axis line with an empty tick
// array under it — no time anywhere on the picture — on the brief, on the printed sheet and on the
// patient's own summary. lib/timeAxis.ts is the decision and lib/timeAxis.test.ts holds it at spans no
// fixture has; what only the running app can show is that the ticks reach Recharts and are painted.

/** The labels Recharts writes under the x-axis of whichever line chart this surface is showing. */
const axisLabels = (page: Page): Locator =>
  lineChart(page).locator(".recharts-xAxis .recharts-cartesian-axis-tick-value");

/** A weekday as `weekday: "short"` writes one, in the en-US locale these browsers run in. */
const WEEKDAY = /^[A-Za-z]{2,4}$/;
/** And a clock time as the axis writes one: "6 AM", "6:30 AM" — or a weekday, where a day turns over. */
const CLOCK = /^(\d{1,2}(:\d{2})? ?[AaPp]\.?[Mm]\.?|\d{1,2}:\d{2}|[A-Za-z]{2,4})$/;

/**
 * The glucose chart's time axis is readable: labelled at all, labelled distinctly, and in the unit of its
 * span.
 *
 * Three assertions rather than one, because "not empty" is the weakest half of what T187 asks for and the
 * easiest to satisfy wrongly: the axis this replaced would have passed it with three ticks all reading
 * "Sun", which is the same chart telling the same reader nothing. So the labels must also differ from each
 * other, and they must be in the unit the span calls for — hours inside a day, weekdays over one.
 */
export async function expectTimeAxisLabelled(page: Page, where: string, unit: "hour" | "day"): Promise<void> {
  const ticks = axisLabels(page);
  await expect(ticks.first(), `${where}: the glucose chart's time axis carries no labels at all`).toBeVisible(DRAWN);
  const labels = (await ticks.allTextContents()).map((s) => s.trim()).filter(Boolean);

  expect(labels.length, `${where}: a time axis needs both ends of the line named, and got ${labels.join(" | ") || "nothing"}`).toBeGreaterThanOrEqual(2);
  expect(new Set(labels).size, `${where}: two labels read the same, so the axis says less than it looks: ${labels.join(" | ")}`).toBe(labels.length);

  if (unit === "day") {
    // The week, unchanged: criterion 2's other half. Nothing on a multi-day axis carries a digit.
    for (const label of labels) expect(label, `${where}: a week's axis is weekdays`).toMatch(WEEKDAY);
    return;
  }
  for (const label of labels) expect(label, `${where}: a day's axis is clock times`).toMatch(CLOCK);
  expect(
    labels.some((l) => /\d/.test(l)),
    `${where}: a chart of one day labelled in weekdays places nothing in it: ${labels.join(" | ")}`,
  ).toBeTruthy();
}
