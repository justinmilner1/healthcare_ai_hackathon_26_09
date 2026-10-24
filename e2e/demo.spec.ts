import { expect, test } from "@playwright/test";
import { DEMO_PORT } from "../playwright.config";
import { postJson } from "./api";
import { DEMO_EMAIL, MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { shot } from "./shot";

// Demo practices (T32, design §13.4): "a flag on a practice that marks it synthetic; demo practices are
// excluded from retention sweeps and alarms and are never emailed real addresses."
//
// Two of the three are asserted here, because they are the two with a screen: the flag as an admin sees it on
// the settings page, and the address rule as staff see it in the dashboard's Messages column. The sweep is
// nightly and has no screen at all, so it is asserted in lib/retentionStore.test.ts against a real database,
// and the alarm label in lib/log.test.ts and lib/demo.test.ts.
//
// The address rule has a second screen since T145 — the booking wizard, which says before the button what
// this file reads off the dashboard afterwards. It is asserted in e2e/visits.spec.ts, on the one server in
// the suite with a sender behind a channel, because the claim it corrects only exists in an office that can
// send.
//
// `/demo` gets a server of its own (port+4, playwright.config.ts): DEMO_SIGN_IN is what turns the shortcut
// on, and the main server deliberately leaves it off so e2e/signin.spec.ts can see the default — the sign-in
// form with the address filled in.

/** T74 What a delivery tooltip must never contain: a variable name, a credential, the deployment's own
 *  to-do list. Narrower than the guard in lib/delivery.test.ts, which has the senders' real strings behind
 *  it: a tooltip here also carries the provider's message id (§8.3), which is opaque and may spell anything,
 *  so the vendors' own names are left to the unit test. */
const CONFIGURATION = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|api[ _-]?key|credential|verified identity|not configured/i;

test("the seeded practice says it is a demo, on the screen that explains what that changes", async ({ page }) => {
  await signInAsDemo(page);
  await page.goto("/provider/settings");
  await expect(page.getByRole("heading", { name: "Users and roles." })).toBeVisible(LOADED);

  await expect(page.locator(".settings-demo-pill")).toContainText(/DEMO PRACTICE/i);
  // The flag is read-only on purpose: an admin who could set it would be turning their own practice's
  // retention sweep off. So there is a note saying what it does, and no control that changes it.
  await expect(page.locator(".settings-demo-note")).toContainText(/nightly sweep leaves it alone/i);
  await expect(page.locator(".settings-demo-note")).toContainText(/reserved test address/i);
  await expect(page.locator("input#is-demo, [name='isDemo']")).toHaveCount(0);

  await shot(page, "provider-settings-demo");
});

test("a demo practice does not message a number that could be somebody's", async ({ page }) => {
  await signInAsDemo(page);

  // 555-0100 through 555-0199 is the NANP's fictitious range and 555-1234 is not, so in a demo practice the
  // first is messaged and the second is refused before any backend is reached. Both visits are booked into
  // the seeded practice, which `npm run seed` marks `isDemo`. Area code 650 is this spec's own: every other
  // spec books in 415, and a shared number would be a shared patient row (lib/visitStore.ts matches a
  // patient on their contact details, which is what makes a second visit for the same person work).
  // Both twelve characters long, and neither a substring of the other: `hasText` below matches on substrings,
  // so a shorter number would find the row of a longer one that merely starts with it.
  const twoDigits = () => String(Math.floor(Math.random() * 100)).padStart(2, "0");
  const reservedPhone = `+165055501${twoDigits()}`;
  const realPhone = `+16505552${twoDigits()}${Math.floor(Math.random() * 10)}`;
  const book = (name: string, phone: string) =>
    postJson(page.request, "/api/book", { name, phone, channel: "sms", consentMethod: "phone" });
  expect((await book("Demo Reserved Number", reservedPhone)).ok(), "the reserved number books").toBeTruthy();
  expect((await book("Demo Real Number", realPhone)).ok(), "and so does the one that could be somebody's").toBeTruthy();

  await page.goto("/provider");
  // By number rather than by name: the number is what the rule is about, it is on the screen in the same
  // cell, and a patient booked twice keeps the name their first booking gave them.
  const rowFor = (phone: string) => page.locator(".provider-table tbody tr", { hasText: phone }).first();
  const realRow = () => rowFor(realPhone);
  const invitePill = (phone: string) => rowFor(phone).locator(".provider-invite .provider-data-pill").first();

  // The reason is in the pill's tooltip, where §8.3 puts every other "why did this not send" — and it names
  // no number, because that cell is read by staff and the same text goes to the log (§10.3).
  const refused = invitePill(realPhone);
  await expect(refused, "skipped, not failed: there is nothing to retry").toHaveClass(/provider-delivery-skipped/, LOADED);
  await expect(refused).toHaveAttribute("title", /demo practice/i);
  // And in words under the pill, because a dash on its own reads as a bug in the app (§8.3's own argument
  // for the suppression line beside it).
  await expect(realRow()).toContainText(/Demo practice: only test addresses are messaged/i);
  const title = await refused.getAttribute("title");
  expect(title?.includes(realPhone.slice(-4)), "the reason carries no number (§10.3)").toBeFalsy();

  // The reserved number is attempted like any other. What it then runs into is this environment's business —
  // no SMS backend here, ambient AWS credentials in the agents' sandbox — so what is asserted is only that
  // the demo rule was not what stopped it.
  const attempted = invitePill(reservedPhone);
  await expect(attempted).toBeVisible(LOADED);
  await expect(rowFor(reservedPhone)).not.toContainText(/Demo practice:/i);

  // T74 (§8.3) And whatever it ran into, what staff are told about it is theirs to act on. This pill is the
  // suite's one send that really tried and really did not arrive — no sender can deliver to a number in the
  // fictitious range, so it fails in every environment — and its tooltip used to carry "SMS not configured
  // (set Twilio or AWS keys)" from lib/sms.ts, or SNS's own words about an invalid security token.
  //
  // Reloaded until the send has been reported on, because the invite is a job (§3.4) and a job that fails is
  // retried: the dashboard reads `GET /api/provider` once per load, so the first one can honestly show the
  // `…` of a message nobody has come back about yet.
  let attemptedTitle: string | null = null;
  await expect(async () => {
    await page.reload();
    attemptedTitle = await invitePill(reservedPhone).getAttribute("title");
    expect(attemptedTitle ?? "", `the tooltip is written for staff (title: ${attemptedTitle})`).toMatch(
      /Sweet Spot cannot send texts yet|The text did not go out/,
    );
  }).toPass(LOADED);
  expect(attemptedTitle ?? "", `the reserved number is not refused by §13.4 (title: ${attemptedTitle})`).not.toMatch(/demo practice/i);
  expect(attemptedTitle ?? "", "no variable, credential or backend on a practice's screen").not.toMatch(CONFIGURATION);
  // And in words under the pill, for the same reason the demo line above is in words: this dashboard is
  // tested at 375px (§6.5), where there is no hover and so no tooltip at all.
  await expect(rowFor(reservedPhone).locator(".provider-delivery-fault")).toContainText(/ask whoever set/i);

  // One screenful at either width, with the row this test booked centred in it: the dashboard is as tall
  // as the practice's visit list and the Messages column on one row is all this is about (T57).
  await shot(page, "provider-dashboard-demo-messages", {
    fullPage: false,
    scrollTo: `.provider-table tbody tr:has-text("${realPhone}") .provider-invite`,
    block: "center",
    inline: "center",
  });
});

test.describe("DEMO_SIGN_IN=1", () => {
  test.use({ baseURL: `http://localhost:${DEMO_PORT}` });

  test("/demo signs into the demo practice with no link to read", async ({ page }) => {
    // §13.4 wants `/demo` to open the demo practice on staging, where there is no inbox to read the link out
    // of. What happens is still an Auth.js sign-in: the link is minted instead of emailed (lib/auth.ts
    // mintSignInUrl) and followed, so the session, its two clocks and its `Session` row are the real ones.
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/provider(\?|$|\/)/, LOADED);
    // A refused link lands back on /provider/signin?error=Verification, which the pattern above matches too.
    await expect(page).not.toHaveURL(/\/provider\/signin/);

    const provider = await (await page.request.get("/api/provider")).json();
    expect(provider.email).toBe(DEMO_EMAIL);
    expect(provider.role).toBe("admin");
    await expect(page.locator(".provider-table")).toBeVisible(LOADED);
    await shot(page, "demo-signed-in", { fullPage: false });

    // Nothing was emailed: this server has its own mailbox and the shortcut is the whole point.
    const { readdirSync } = await import("node:fs");
    const mailbox = (() => {
      try {
        return readdirSync(`${MAIL_DIR}-demo`).filter((f) => f.endsWith(".txt"));
      } catch {
        return [];
      }
    })();
    expect(mailbox, "the link was minted, not sent").toEqual([]);
  });

  test("the minted link is one-use, like an emailed one", async ({ page }) => {
    // The shortcut is not a standing door: it mints one of Auth.js's own verification tokens, and Auth.js
    // deletes the token when it is redeemed. So the URL the first sign-in went through is refused afterwards.
    const seen: string[] = [];
    page.on("request", (request) => seen.push(request.url()));
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/provider(\?|$|\/)/, LOADED);
    const used = seen.find((url) => url.includes("/api/auth/callback/email"));
    expect(used, "/demo redirected through Auth.js's own callback").toBeTruthy();

    await signOutOfBrowser(page);
    await page.goto(used!);
    await expect(page).toHaveURL(/\/provider\/signin/, LOADED);
    await expect(page.locator("body")).toContainText(/already been used|expired/i);
  });
});
