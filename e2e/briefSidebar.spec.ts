import { expect, test, type Page } from "@playwright/test";
import { NAME_LOADING, NO_NAME_SET } from "../lib/team";
import { postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { SCREENFUL, shot } from "./shot";

// T186 (design §2.1, §2.6, §12.5): the heading at the top of the brief's sidebar, which is the page's <h1>.
//
// It read `provider?.name ?? "…"`, and `??` catches only null and undefined — so one ellipsis answered two
// questions. "GET /api/provider has not come back" is a wait and resolves; "this account has no name on it"
// is not and never does. §2.1 leaves every practice's first admin nameless until somebody types one into
// settings, and every colleague an admin invites by email with none at all, so on the ordinary account the
// clinician's own brief was headed by a loading glyph for ever — and a page that had finished loading was
// the same picture as one still loading.
//
// Both halves in one test, deliberately. The rule is only met if the nameless account is told something
// true *and* the named one still reads exactly as it did: "say less to everybody" would pass either half
// on its own. So the test signs in twice, over one brief each.
//
// Desktop only. `.sour-practice` is `display: none` under the phone breakpoint (app/globals.css), which is
// a decision about the §6.5 layout and not something to widen for a screenshot — the answer T181 reached
// for the §2.2 import dialog.

/** A patient nothing else in the run will use: two Playwright projects share one database, and §2.2 matches
 *  an existing patient on phone or email. */
const unique = (prefix: string) => {
  const name = `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return { name, phone: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`, email: `${name.replace(/\s+/g, ".").toLowerCase()}@example.com` };
};

/** One visit of the signed-in provider's, so the sidebar is read over a brief the practice really has
 *  rather than over an empty page. */
async function book(page: Page, providerId: string, prefix: string) {
  const who = unique(prefix);
  const res = await postJson(page.request, "/api/book", { ...who, providerId, visitType: "follow_up", reason: "highs after dinner", channel: "both", consentMethod: "phone" });
  const booked = (await res.json()) as { visitId: string };
  expect(booked.visitId, `POST /api/book: ${res.status()}`).toBeTruthy();
  return { ...who, ...booked };
}

/** The sidebar block the ticket is about: the PRACTICE eyebrow, the heading, and the practice line under it. */
const practiceBlock = (page: Page) => page.locator(".sour-practice");

test("the brief's sidebar names an account with no name, and still names one that has a name", async ({ page }, testInfo) => {
  testInfo.skip(testInfo.project.name === "mobile", "`.sour-practice` is display:none under the phone breakpoint (app/globals.css §6.5), so this block has no 375px frame");

  // 1. The nameless account. An address nobody has invited gets a practice of its own and is its admin, and
  //    nothing writes a name on its behalf — a magic link carries an address only (§5.1, lib/authAdapter.ts).
  //    This is the state `desktop-sour-invite-no-handover.png` was taken on, and the state the ticket is for.
  const me = await signInAs(page, freshEmail("brief-sidebar-nameless"));
  expect(me.name, "a fresh sign-in has no name on the row, which is the whole subject").toBeFalsy();
  const mine = await book(page, me.id, "Sidebar No Name");

  await page.goto(`/provider/${me.id}?visit=${mine.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText(mine.name, LOADED);

  const block = practiceBlock(page);
  const heading = block.locator("h1");
  // Criterion 1: something true of the account, in the users table's own words (lib/team.ts memberSubLine).
  await expect(heading).toHaveText(NO_NAME_SET, LOADED);
  // Criterion 2 on the screen, as lib/team.test.ts asserts it on the function: this is not what a page that
  // has not loaded says. The <h1> is also the page's accessible name (§12.5), which an ellipsis is not.
  await expect(heading).not.toHaveText(NAME_LOADING);
  expect(await heading.innerText()).not.toContain(NAME_LOADING);
  // Beside the line it sits over — already painted in that committed frame, which is how the ellipsis above
  // it was known to be a final state rather than a flicker.
  await expect(block.locator("p")).toHaveText(me.practice!);
  // Criterion 5: staff's words, naming no backend or variable, and not the practice line said twice.
  const sidebar = await block.innerText();
  expect(sidebar, "no backend, variable or credential over a clinician's name (§3.7, §10.6)").not.toMatch(/SES|SNS|AWS|_KEY|_SECRET|environment variable|null|undefined/);
  expect(sidebar.split(me.practice!).length - 1, "the practice is named once, not twice").toBe(1);

  await shot(page, "provider-sour-sidebar-no-name", SCREENFUL);

  // 2. The half that keeps it honest: an account that *has* a name reads exactly as it did before, both
  //    lines of it. A rule met by saying less to everybody would pass the half above and fail here.
  await signOutOfBrowser(page);
  const demo = await signInAsDemo(page);
  expect(demo.name, "the seeded provider is the named account (lib/practice.ts)").toBe("Dr. Demo Endo");
  const theirs = await book(page, demo.id, "Sidebar Named");

  await page.goto(`/provider/${demo.id}?visit=${theirs.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText(theirs.name, LOADED);
  await expect(practiceBlock(page).locator("h1")).toHaveText("Dr. Demo Endo", LOADED);
  await expect(practiceBlock(page).locator("p")).toHaveText("Sweet Spot Endocrinology");

  await shot(page, "provider-sour-sidebar-named", SCREENFUL);
});
