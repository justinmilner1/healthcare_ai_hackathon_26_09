import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { findDevMail } from "../lib/devMailbox";
import { spanNoun } from "../lib/plural";
import { postJson } from "./api";
import { MAIL_DIR } from "./auth";
import { LOADED, LOADED_TIMEOUT_MS } from "./budget";

// Verifying a patient link the way a patient does (design §2.3, §5.3): open the link, read the six-digit
// code out of the message that was "sent", type it in. Nothing is stubbed — with no SMS or email backend
// configured, lib/mailer.ts drops the code in DEV_MAIL_DIR instead of sending it (the console mailer the
// ticket's acceptance criteria name), and these helpers read it back out of there.
//
// playwright.config.ts starts four servers with a mailbox each, and a code goes in whichever one drains the
// `notify.code` job — see latestCode, which is why these read all of them and e2e/auth.ts's sign-in links do
// not. MAIL_DIR comes from e2e/auth.ts, which already names it for those links.

/**
 * Every patient these specs book needs a contact method, because that is where the code goes — and a
 * different one each time. The address is the key the mailbox is searched by, and the desktop and mobile
 * projects run every spec against the same database and the same mailbox: two bookings sharing an address
 * put two visits' codes under one name, and "the newest code for this address" then belongs to whichever
 * project got there second. Call it once per booking and pass the result around.
 */
export const patientEmail = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${randomBytes(4).toString("hex")}@example.test`;

/**
 * Every mailbox the suite's servers write to, newest file first across all of them.
 *
 * A code is not written by the server the patient is talking to: POST /api/verify enqueues a `notify.code`
 * job, and the servers share one database, so whichever of them next drains inline is the one that sends it
 * — and it writes to *its* mailbox. Looking only in the main one loses roughly one code in fifty to the
 * degraded server's box, as a timeout fifteen seconds later with nothing to show for it.
 *
 * Searching all of them is safe because every booking gets its own address (patientEmail), so a code found
 * under one is unambiguously this patient's. Sign-in links are the opposite case and stay per-mailbox in
 * e2e/auth.ts: those all go to the one demo address, so only the directory tells them apart.
 */
const MAIL_DIRS = (first: string) =>
  [...new Set([first, MAIL_DIR, `${MAIL_DIR}-degraded`, `${MAIL_DIR}-runner`, `${MAIL_DIR}-dexcom`])];

/**
 * The newest code sent to this address, or null while nothing has arrived.
 *
 * The walk is lib/devMailbox.ts's findDevMail, newest file first across every box, because these boxes are
 * shared with the sign-in links e2e/auth.ts claims by renaming: a read of a listed name can find the file
 * already gone, and a code this spec is waiting for must not be lost to an ENOENT over somebody else's mail
 * (T65). findDevMail skips what it cannot read, so waitForCode's retry loop gets to go round again.
 */
export function latestCode(email: string, dir = MAIL_DIR): string | null {
  // The subject is "Your code is 480913" (lib/notify.ts codeTemplates), which is also the only place in the
  // mailbox a bare six-digit number appears.
  return findDevMail(MAIL_DIRS(dir), email, (raw) => raw.match(/^Subject: Your code is (\d{6})$/m)?.[1] ?? null);
}

/**
 * Wait for the code: POST /api/verify answers 202 and the `notify.code` job sends after the response.
 *
 * `notBefore` is for a resend, where the point is that the *next* code arrives. It is not the default,
 * because reopening a link reuses a code that is still live rather than minting a second one (§5.3) — so
 * insisting on a different one there would wait for something that is never coming. Every spec books its
 * patient with its own address, which is what keeps "the newest code for this address" unambiguous.
 */
export async function waitForCode(email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  // A deadline off the suite's shared budget rather than a count of attempts (T95, e2e/budget.ts): sixty of
  // them was fifteen seconds of a wait on the `notify.code` job draining, with no way of being raised.
  const deadline = Date.now() + LOADED_TIMEOUT_MS;
  for (;;) {
    const code = latestCode(email, dir);
    if (code && code !== notBefore) return code;
    if (Date.now() >= deadline) throw new Error(`no verification code arrived for ${email} in ${dir} within ${LOADED_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Type the code on a code screen that is already showing, and wait for the page behind it.
 *
 * `notBefore` is the code this address was last sent, for a test that verifies the same patient twice — a
 * regenerated link (§5.5) sends a second code to the same address, and the first one is still the newest
 * file in the mailbox until it lands. Without it the screen gets the old code and stays where it is.
 */
export async function enterCode(page: Page, email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  const field = page.getByLabel("6-digit code");
  await expect(field).toBeVisible(LOADED);
  const code = await waitForCode(email, dir, notBefore);
  await field.fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  // The gate is a server component, so a verified link is a navigation away from the code screen.
  await expect(field).toBeHidden(LOADED);
  return code;
}

/** The one tap on the consent screen (design §2.4, T09). */
export const AGREE = /I agree/i;

/**
 * The eyebrow over the patient summary's hero (design §2.7, T123).
 *
 * Three specs assert it — one per state the page has, which is the point of it: it is read off
 * `stats.days` through spanNoun() like the three strings below it, so a single-day upload, a week and a
 * visit with nothing shared each get a different line and no two of them may drift apart. Shared here
 * rather than spelled out three times because the selector is the thing that would drift: the eyebrow is
 * in `.patient-summary-hero`, which is outside the `.patient-summary-content` the span assertions in
 * e2e/flows.spec.ts sweep, and that is how it stayed literal through T100 and T114.
 */
export const EYEBROW = (page: Page) => page.locator(".patient-summary-hero .ss-eyebrow");

/**
 * The hero's line about the appointment (§2.7). The one line on this page that is a claim about the
 * calendar rather than about the data, and the one the T162 off-by-one lived in: it counted 24-hour spans,
 * so a visit at 17:00 today read "is tomorrow" and a visit tomorrow morning read "2 days". Shared here for
 * the same reason as `EYEBROW` above — it sits in `.patient-summary-hero`, outside the
 * `.patient-summary-content` the other patient-page assertions sweep, which is how the wrong number stayed
 * in a screenshot both routines read every run. lib/visitCountdown.test.ts holds the sentence itself to the
 * calendar; this is the assertion that it is the sentence the page renders.
 *
 * All three dated branches go through this one locator, which is the point of it being here (T163): the
 * count is asserted on the journey's booking, three calendar days out (e2e/journey.spec.ts), and the two
 * branches that name a day instead of a number — the visit later today and the one the next morning, which
 * are the two the off-by-one got wrong — on a pinned clock in e2e/flows.spec.ts. A branch asserted by a
 * selector written beside it is a branch that can drift away from the other two.
 */
export const COUNTDOWN = (page: Page) => page.locator(".patient-summary-hero .patient-summary-countdown");

/**
 * Take the consent screen, if this visit has not been past it yet (§2.4 is first open only, so the second
 * verification of the same visit — a regenerated link, another device — goes straight through). Returns
 * whether there was a screen to take, so a spec can assert on either.
 *
 * The screen is server-rendered by the gate, so it is in the document the moment the code screen goes: the
 * short wait is for the parse of that document, not for app logic.
 *
 * The one wait in the suite that does not take the shared budget (T95, e2e/budget.ts), because expiring is
 * one of its two answers rather than a failure: the caller before this line has already awaited
 * `domcontentloaded`, so the button is in the parsed document or it is not, and nothing asynchronous is on
 * its way. Taking 30s here would add 30s to every verification of a visit that is already past consent.
 */
export async function acceptConsent(page: Page): Promise<boolean> {
  const agree = page.getByRole("button", { name: AGREE });
  await page.waitForLoadState("domcontentloaded");
  try {
    // eslint-disable-next-line no-restricted-syntax -- see above: expiring here is an answer, not a slow box
    await agree.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return false;
  }
  // Accepting reloads through the gate, and the wait for that reload is armed *before* the click, not after.
  // The obvious "wait for the button to go" is a trap: the button renames itself to "One moment…" while the
  // POST is in flight, so a locator that matches it by name stops matching before the navigation has even
  // started — and the spec's next goto then cancels the reload, which Playwright reports as ERR_ABORTED on
  // that goto, several lines from the cause.
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), ...LOADED });
  await agree.click();
  await navigated;
  await page.waitForLoadState("load");
  return true;
}

/**
 * Verify in the browser the way a patient does: open the link, which is what sends the code, type it, and
 * take the consent screen behind it (§2.4). Leaves the page on whatever the link opens, with the session
 * cookie in the browser's jar.
 *
 * The consent tap is in here rather than in every spec because it is now part of opening a link, not a
 * feature any of them are about — e2e/consent.spec.ts is the one that drives the screen itself, and it uses
 * `enterCode` so it arrives with the screen still up.
 */
export async function verifyLink(page: Page, token: string, email: string, dir = MAIL_DIR, notBefore: string | null = null): Promise<string> {
  await page.goto(`/s/${token}`);
  const code = await enterCode(page, email, dir, notBefore);
  await acceptConsent(page);
  return code;
}

/**
 * The same thing for a bare request context, for the specs that read the API directly. The cookie lands in
 * that context's jar, so its later GETs speak as the verified patient. Consent is answered here too, for the
 * same reason as above: a context that has verified is a patient who got through the door, and POST
 * /api/consent is behind the same verified session.
 *
 * `consent: false` stops at the verified session and leaves the screen unanswered, for a spec that is about
 * the answer itself: accepting here would be the row it then goes looking for (e2e/audit.spec.ts, T51).
 */
export async function verifyByApi(
  request: APIRequestContext,
  token: string,
  email: string,
  dir = MAIL_DIR,
  { consent = true }: { consent?: boolean } = {},
): Promise<string> {
  const before = latestCode(email, dir);
  const asked = await postJson(request, "/api/verify", { token });
  expect(asked.status(), `POST /api/verify: ${await asked.text()}`).toBe(202);
  const code = await waitForCode(email, dir, before);
  const verified = await postJson(request, "/api/verify", { token, code });
  expect(verified.status(), `POST /api/verify with the code: ${await verified.text()}`).toBe(200);
  if (!consent) return code;
  const consented = await postJson(request, "/api/consent", { token, accept: true });
  expect(consented.status(), `POST /api/consent: ${await consented.text()}`).toBe(200);
  return code;
}

/** A lat/long pair as lib/location.ts writes one. Nothing on §2.7's page may read like this (T128). */
const COORDINATES = /-?\d+\.\d{3}, -?\d+\.\d{3}/;

/**
 * No coordinates anywhere on the patient's own summary (T128, design §2.7).
 *
 * `placeLabel` is how an unnamed Timeline stop is named for the clinician's brief and the printed sheet
 * (T62), and it used to reach the patient through two surfaces at once: the Where column and the chart's
 * marker labels. So this sweeps the whole of `.patient-summary-content`, which holds both — a third surface
 * growing its own copy of the same string fails here rather than in a reviewer's sweep.
 *
 * The chart is the half that has to be waited for: its labels are painted client-side once the card has
 * been measured, and a chart that has not drawn yet would pass a negative assertion without having drawn
 * anything. The spike markers appear in that same render and are the only circles in the card — the line
 * carries no dots — so one of them on the page is the whole wait.
 */
export async function expectNoCoordinates(page: Page, where: string): Promise<void> {
  await expect(page.locator(".patient-chart-wrap circle"), `the chart's spike markers on ${where}`).not.toHaveCount(0, LOADED);
  await expect(page.locator(".patient-summary-content"), `a lat/long on ${where}`).not.toContainText(COORDINATES);
}

/**
 * §2.7's two narrative cards, by the headings the page gives them (app/patient/[id]/page.tsx).
 *
 * Shared here rather than beside the test that first drew them (T206, e2e/flows.spec.ts) because T208 gave
 * them a second reader in e2e/a11y.spec.ts, and a card located by a heading written twice is a card the two
 * specs can stop agreeing about.
 */
export const patternsCard = (page: Page) =>
  page.locator(".patient-report-card").filter({ has: page.getByRole("heading", { level: 2, name: /^What your .+ showed$/ }) });
export const questionsCard = (page: Page) =>
  page.locator(".patient-report-card").filter({ has: page.getByRole("heading", { level: 2, name: "Things you might ask your doctor" }) });

/**
 * Three patterns and three questions in the register §7 asks for, so the cards read as the product's own.
 *
 * **These patterns presume a seven-day visit**, and only `e2e/flows.spec.ts`'s has one: they name "the
 * week", four overnight highs and a run of short nights, which is `data/dexcom_clarity_sample.csv`'s span
 * and not any narrower one. `lib/prompts.ts` tells the model "the data covers the ${spanNoun(days)} and
 * nothing more", so a week's narrative over one day is not a page the product can produce — and a
 * screenshot of one reads as a §2.7 span bug that is not there, which is the whole of T217. A spec whose
 * visit is narrower therefore needs its own set rather than this one: `ONE_DAY_NARRATIVE_PATTERNS` below
 * is the set for `clarity_window.csv`'s single day, and `expectNoWiderSpan` is what holds either of them
 * to the visit it is rendered over.
 *
 * The questions name no span at all, which is why there is one set of those and two of these.
 */
export const NARRATIVE_PATTERNS = [
  "Your readings stayed between 70 and 180 for most of the week.",
  "Three of your four overnight highs came after dinners out past 8pm.",
  "Mornings after nights under six hours ran about 20 mg/dL higher.",
];

/**
 * The same three patterns over the narrower visit `e2e/a11y.spec.ts` builds (T217).
 *
 * That visit is `clarity_window.csv` — 84 readings inside one calendar day, 06:00 to 12:55, with one rise
 * (98 → 214, peaking at 08:00) and one dip below range (to 48, just before 11:00) — beside
 * `whoop_cycles.csv`'s three nights: 7.3h at 68% recovery, 5.3h at 41%, 7.7h at 74%.
 *
 * Every claim here is one that page shows, and none of them names a span. The heading drawn over them is
 * `What your day showed` (`spanNoun(1)`), so "the week", a second high, and mornings in the plural would
 * each be contradicted by the frame they appear in. The three nights are the ones the Sleep card draws,
 * and they fall *after* the glucose window rather than before it — so nothing here reads a morning
 * against the night before it, which is the one pairing this pair of fixtures cannot make.
 */
export const ONE_DAY_NARRATIVE_PATTERNS = [
  "Your readings climbed from 98 to 214 mg/dL between 7 and 8 in the morning.",
  "They dipped to 48 mg/dL just before 11, then settled back near 100.",
  "The night you slept 5.3 hours scored your lowest recovery, 41%.",
];

export const NARRATIVE_QUESTIONS = [
  "Should I keep the same evening dose?",
  "Is six hours of sleep enough for me?",
  "Would a different breakfast help the mid-morning rise?",
];

/**
 * Nothing on a §2.7 narrative card names a span wider than the visit drawn under it (T217, §2.7, §7).
 *
 * T217 was a fixture and not the product: a week's patterns patched onto a one-day visit, with the right
 * heading above them and the wrong three sentences below. Nothing in the suite could see it, because the
 * assertions over these cards are about markup and order and the words are whatever the caller passed —
 * so it survived until a reviewer read the PNG. §12.3 makes these frames the evidence a ticket is judged
 * on, so the frame is now asserted rather than only looked at: a set of patterns edited later, or a third
 * spec inheriting one written for a wider visit, fails here instead of becoming the next picture of the
 * product appearing to contradict itself.
 *
 * Which words are too wide is decided off the same day count the heading is drawn from, so this and the
 * page cannot disagree about it: "week" is honest at seven days and not at one, plural "days" at two and
 * not at one, and a month is wider than anything `data/fixtures/` holds. Singular "day" is left alone —
 * it is what the heading itself says.
 */
export async function expectNoWiderSpan(card: Locator, days: number, where: string): Promise<void> {
  const tooWide = [/\bmonths?\b/i, /\byears?\b/i];
  if (days < 7) tooWide.push(/\bweeks?\b/i);
  if (days < 2) tooWide.push(/\bdays\b/i);
  for (const word of tooWide) {
    await expect(
      card,
      `${where}: ${spanNoun(days)} of data, so nothing on the card says /${word.source}/`,
    ).not.toContainText(word);
  }
}

/**
 * Put a narrative on the saved summary on its way to the browser (T206, T208).
 *
 * This suite has no model gateway, so `degradedPair` (lib/sourRun.ts) writes `patterns: []` and
 * `questions: []` and both cards are gated out of the page — which is how neither had ever been drawn, by
 * any spec, at any count. A caller therefore runs a real `sour.run` first, asserts the saved pair is empty,
 * and patches only these two arrays: every number, flag and chart on the screen stays the saved summary's
 * own, which is what keeps the frame a page the product can produce (§6.3, §11.3, and the mistake T196
 * corrected in e2e/followup.spec.ts).
 *
 * `get` is read per request rather than bound once, so one registration serves a test that walks several
 * counts. Two `page.route` registrations would not: the second sits behind the first, and the test would
 * read the same count twice while looking as though it had read two.
 */
export async function patchNarrative(page: Page, get: () => { patterns: string[]; questions: string[] }): Promise<void> {
  // A regex rather than a glob: `**` around a path segment is the kind of pattern that silently matches
  // nothing, and a route that never intercepts would leave the caller asserting the unpatched page.
  await page.route(/\/api\/patient\//, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { patientSummary: { patterns: string[]; questions: string[] } | null };
    if (body.patientSummary) {
      const narrative = get();
      body.patientSummary.patterns = narrative.patterns;
      body.patientSummary.questions = narrative.questions;
    }
    await route.fulfill({ response: res, json: body });
  });
}

/**
 * A §2.7 narrative card as a screen reader resolves it (T208, design §2.7, §12.5, §7).
 *
 * Both cards draw a numeral down their left edge and both suppress the list marker that would otherwise
 * draw one (`list-style: none`, app/globals.css), so each has two numbers available to the accessibility
 * tree and must expose exactly one. The element is asserted rather than the role, because `<ul>` and `<ol>`
 * both resolve to `role=list`: which element it is *is* the thing this covers — §7 orders both arrays
 * "most important first" (lib/prompts.ts) and lib/sourRun.ts keeps them that way, so an edit back to `<ul>`
 * would say the order does not matter while the page draws 1, 2, 3.
 *
 * The chips are checked from the tree's side as well as by their attribute: the aria snapshot is what a
 * reader is actually handed, so an item announced as "1 Should I keep the same evening dose?" fails here
 * whichever way the numeral got back in.
 */
export async function expectOrderedNarrative(card: Locator, items: string[], where: string): Promise<void> {
  const list = card.locator("ol");
  await expect(list, `${where}: one ordered list`).toHaveCount(1, LOADED);
  await expect(card.locator("ul"), `${where}: nothing on the card says its order does not matter`).toHaveCount(0);
  await expect(list.locator("li"), `${where}: one item per entry`).toHaveCount(items.length);

  // The chip is still drawn, and still drawn: `aria-hidden` changes what is announced and nothing about
  // what is in the picture, so an edit that reached for `display: none` instead fails here.
  const chips = list.locator("li > span:first-child");
  await expect(chips, `${where}: a numeral per item`).toHaveText(items.map((_, index) => String(index + 1)));
  await expect(chips.first(), `${where}: the numerals are visible`).toBeVisible();
  await expect(
    list.locator('li > span:first-child:not([aria-hidden="true"])'),
    `${where}: every numeral is out of the accessibility tree`,
  ).toHaveCount(0);

  // And the tree itself, which is what a reader is handed: one listitem per item, announced as its own
  // sentence with no numeral in front of it. A numeral that got back in by any route fails here.
  await expect(list, `${where}: each item is announced once`).toMatchAriaSnapshot(
    ["- list:", ...items.map((item) => `  - listitem: ${JSON.stringify(item)}`)].join("\n"),
  );
}
