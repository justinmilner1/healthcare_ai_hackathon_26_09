import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T84 (design §2.4, §2.5, §6.4): the card at the end of the connections step, in both of the states it has.
//
// The tick on its first row was unconditional while the sentence beside it was not, so a patient who shared
// nothing was shown the flow's own CONNECTED glyph against the words "No data connected yet" — on a screen
// whose eyebrow reads SETUP COMPLETE. §2.5 makes the data panel optional and §2.4 promises the patient that
// sharing is their choice, which only means something if the screen can tell them it did not happen.
//
// Both states, on both projects, because the fix is a glyph and a colour and the evidence for it is the
// §12.3 screenshot as much as the assertion: the desktop and mobile runs write
// `<project>-connect-done-empty.png` and `<project>-connect-done-connected.png`. The assertions read
// `data-icon` off the glyph itself rather than the class around it, since the class is a hashed CSS module
// name and the thing that regressed is which shape the row draws.

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"));

/** A booked visit with an address for the code to go to. Booking is staff's job (§5.2), so someone signs in,
 *  books, and signs out, leaving the browser as a patient's. */
async function book(page: Page, name: string) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", {
      name,
      email,
      visitType: "follow_up",
      reason: "mornings running high",
      channel: "none",
    })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, email };
}

/** The mark on the first row of the setup-complete card, whichever of the two it is drawing. */
const dataMark = (page: Page) => page.locator("[data-mark]");

/**
 * The contrast between the mark's glyph and the badge it sits in, as the browser paints them.
 *
 * Measured here rather than left to axe: the glyph is a stroked `<svg>`, and axe's `color-contrast` rule
 * judges text only, so the one thing §6.4 asks about the new mark is the one thing an axe pass would not
 * have looked at. The bar is WCAG 1.4.11's 3:1 for a graphical object, not 4.5:1, which is about text.
 *
 * There is no axe pass on this screen for a second reason: it has two serious `color-contrast` findings of
 * its own, both older than this ticket and neither about the mark — `.readyRow small` at #8f858b on #fffafb
 * (3.44:1 at 10px) and the "View my week" button, white on the `--pink` brand colour #f75d7c (3.08:1).
 * Filed as T104; the brand colour in particular is a product decision rather than this ticket's to make.
 */
async function markContrast(page: Page): Promise<number> {
  return dataMark(page).evaluate((span) => {
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: string) => {
      const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const style = getComputedStyle(span);
    // The svg is `stroke: currentColor` over the badge's own background, so those two are the pair.
    const glyph = luminance(style.color);
    const badge = luminance(style.backgroundColor);
    return (Math.max(glyph, badge) + 0.05) / (Math.min(glyph, badge) + 0.05);
  });
}

test("the setup-complete card marks nothing-shared differently from something-shared", async ({ page }) => {
  const { token, email } = await book(page, "E2E Connections");
  await verifyLink(page, token, email);
  await page.goto(`/s/${token}/intake`);
  await page.getByRole("button", { name: /Let's get started/i }).click();
  const dexcomInput = page.getByLabel(/Upload Dexcom file/i);
  await expect(dexcomInput).toBeAttached(LOADED);

  // Nothing shared: the path the ticket was filed from, and the one a patient who got lost ends up on.
  await page.getByRole("button", { name: /Skip connections/i }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expect(page.getByText("No data connected yet")).toBeVisible();
  // The sentence under it follows the state too: "add more data" under "No data connected yet" offered to
  // add to nothing, which is the mark's own confusion in words.
  await expect(page.getByText("You can return to connections to add your data.")).toBeVisible();
  await expect(dataMark(page)).toHaveAttribute("data-mark", "none");
  // The glyph, not just the state: the tick is what the step before this one uses for CONNECTED, so the row
  // reporting that nothing arrived must not be drawing it.
  await expect(dataMark(page).locator('svg[data-icon="check"]')).toHaveCount(0);
  await expect(dataMark(page).locator('svg[data-icon="info"]')).toHaveCount(1);
  // §6.4: the neutral mark has to clear the same bar as the one it replaced.
  expect(
    await markContrast(page),
    "§6.4, WCAG 1.4.11: the neutral mark against its badge",
  ).toBeGreaterThanOrEqual(3);
  await shot(page, "connect-done-empty", WHOLE_PAGE);

  // One source shared: unchanged, tick and count, which is the half of the screen that was always right.
  await page.getByRole("button", { name: /Back to connections/i }).click();
  await expect(dexcomInput).toBeAttached(LOADED);
  await dexcomInput.setInputFiles({ name: "Clarity_export.csv", mimeType: "text/csv", buffer: clarity() });
  await expect(page.getByText(/records securely added/i)).toBeVisible(LOADED);
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expect(page.getByText("1 data source connected")).toBeVisible();
  await expect(page.getByText("You can return to connections to add more data.")).toBeVisible();
  await expect(dataMark(page)).toHaveAttribute("data-mark", "connected");
  await expect(dataMark(page).locator('svg[data-icon="check"]')).toHaveCount(1);
  expect(
    await markContrast(page),
    "§6.4, WCAG 1.4.11: the tick against its badge",
  ).toBeGreaterThanOrEqual(3);
  await shot(page, "connect-done-connected", WHOLE_PAGE);
});
