import { test, type Locator, type Page } from "@playwright/test";

// The one place a screenshot gets taken (T57, design §12.3).
//
// §12.3 exists so that both routines can *see* what they built, and `fullPage: true` on the mobile project
// was quietly undoing it: the provider dashboard is as tall as the practice's visit list, so by the time the
// phone ran it the shot was 20,000 pixels of three-pixel rows — 55 phone screens stacked into one image, in
// which nothing is legible at any size a reviewer can open. e2e/audit.spec.ts and e2e/deletion.spec.ts had
// each hit this and fixed it locally; eleven other specs still hardcoded `fullPage: true`, and every one of
// them grew taller with each ticket that booked another visit.
//
// So the default is per project and decided here: the desktop shoots the document, where a row is one line
// of a table and the whole page is worth having, and the phone shoots its viewport, where it is not. A spec
// that wants something else says so — `{ fullPage: true }` for a phone shot of a whole page (the patient
// screens in e2e/mobile.spec.ts are exactly that), `MODAL` for a dialog, which is one viewport's worth of
// subject at either width.

/** The default for this project: the document on the desktop, one screenful on the phone. */
export const fullPageByDefault = (): boolean => test.info().project.name === "desktop";

export type ShotOptions = {
  /**
   * Override the per-project default: `true` shoots the whole document even on a phone, `false` shoots one
   * viewport even on the desktop.
   */
  fullPage?: boolean;
  /**
   * Scroll this to the top of the viewport before shooting, for a subject that is below the fold on a phone.
   * A selector string or a locator; the first match is used.
   */
  scrollTo?: string | Locator;
  /**
   * Where `scrollTo` puts the subject vertically. `"start"` (the default) is the top of the viewport, which
   * is what a card taller than the screen wants — `scrollIntoViewIfNeeded` stops as soon as the card is
   * barely on screen and leaves the shot mid-rows with no header on it. `"center"` is for a single row
   * inside a long table, which otherwise lands half cut off at the bottom edge.
   */
  block?: "start" | "center" | "end" | "nearest";
  /**
   * And horizontally. The dashboard's table is `min-width: 1120px` inside an `overflow-x: auto` card
   * (app/globals.css), so at 375px a third of it is on screen and the Stage, Messages and Actions columns
   * are off to the right — which is where most of what these tests assert on lives. Passing the cell rather
   * than the row as `scrollTo`, with `inline: "center"`, brings that column into the shot.
   */
  inline?: "start" | "center" | "end" | "nearest";
  /** Freeze the 480ms card fade, so the committed shot is the layout and not a half-faded card. */
  animations?: "disabled" | "allow";
};

/** A dialog: one viewport's worth of subject, at either width. */
export const MODAL: ShotOptions = { fullPage: false };

/**
 * The page itself is the subject, at either width.
 *
 * For a page that fits in about two phone screens and whose layout is the point: the code screen, consent,
 * the Sweetie transcript, the connect steps. Nothing on them grows with the practice's data, so the shot has
 * a fixed height, and the whole-page layout at 375px is what design §6.5 asks to be able to look at. A page
 * taller than that takes the default instead and gets a screenful on the phone — a 7,000-pixel column of a
 * clinician's brief is the same unreadable picture the dashboard was, only shorter.
 */
export const WHOLE_PAGE: ShotOptions = { fullPage: true };

/**
 * Write `e2e/screenshots/<project>-<name>.png`, the filename §12.3 and every
 * `docs/screenshots/tickets/*` reference depend on.
 */
export async function shot(page: Page, name: string, options: ShotOptions = {}): Promise<void> {
  const { fullPage = fullPageByDefault(), scrollTo, block = "start", inline = "nearest", animations } = options;
  if (scrollTo) {
    const target = typeof scrollTo === "string" ? page.locator(scrollTo) : scrollTo;
    await target.first().evaluate((element, position) => {
      element.scrollIntoView(position);
    }, { block, inline });
  }
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage,
    ...(animations ? { animations } : {}),
  });
}
