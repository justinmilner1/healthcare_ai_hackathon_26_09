import { expect, test, type Locator, type Page } from "@playwright/test";

// T87 (design §2.6, §2.7, §7.4): what a chart tooltip reads, on each of the three surfaces a chart appears on.
//
// The separator between a tooltip's label and its value used to be Recharts' own default " : ", because
// nothing set it, so every tooltip in the product read "Glucose : 118 mg/dL". It is `TOOLTIP_SEPARATOR` in
// components/chartTooltip.ts now, and this is what stops it drifting back: a default nobody chose is exactly
// the kind of thing that returns when a fourth chart is added.

/** Recharts draws after it has measured itself, like everywhere else in this suite. */
const DRAWN = { timeout: 30_000 };

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
