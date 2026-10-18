import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { patientEmail, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// Design §6.2 from the patient's side: "Every patient message is stored before any model call; the transcript
// survives a crash." The order and the crash behaviour of one turn are unit-tested against fakes in
// lib/sweetieTurn.test.ts; this file asserts the consequence the patient actually sees, through the real
// route, the real Postgres rows and the real page — that the transcript and the stepper live on the server,
// so reloading rebuilds them and losing the answer to a turn loses nothing.
//
// Nothing here is stubbed except the one thing a test cannot otherwise cause: a reply that is thrown away
// before it reaches the browser, which is what a closed tab or a dropped connection does to a turn.

const LOADED = { timeout: 30_000 };
/** Only the real bubbles: the typing dots and the voice interim share the class and are not transcript. */
const BUBBLES = ".sweetie-messages .sweetie-message:not(.sweetie-typing):not(.sweetie-interim)";

/**
 * Everything on screen that is supposed to come back after a reload, in one comparable object.
 *
 * Read with textContent rather than innerText, and with classes rather than screenshots, so the same
 * assertions hold on the mobile project where parts of the sidebar are clipped rather than laid out.
 */
async function onScreen(page: Page) {
  const transcript = await page.locator(BUBBLES).evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
  const stepper = await page.locator(".sweetie-field-progress > li").evaluateAll((els) =>
    els.map((el) => ({
      label: el.textContent?.trim() ?? "",
      done: el.classList.contains("sweetie-field-done"),
      current: el.getAttribute("aria-current") === "step",
    })),
  );
  const progress = await page.locator(".sweetie-progress-card strong").evaluate((el) => el.textContent?.trim() ?? "");
  const answered = await page.locator(".sweetie-progress-card small").evaluate((el) => el.textContent?.trim() ?? "");
  return { transcript, stepper, progress, answered };
}

/** Book a visit as the practice, then open the link as the patient (§5.2 books, §5.3 opens). */
async function openChatAsPatient(page: Page, name: string): Promise<string> {
  await signInAsDemo(page);
  const email = patientEmail(name);
  const booked = await (
    await postJson(page.request, "/api/book", { name, email, visitType: "follow_up", reason: "mornings running high", channel: "none" })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  // The patient has no provider account: the link plus the code sent to the address on file is the whole
  // credential (§5.3), so the provider's session goes before the link is opened.
  await signOutOfBrowser(page);
  await verifyLink(page, booked.token, email, MAIL_DIR);
  // GET /api/sweetie writes the greeting and returns the field list; until it answers there is no stepper.
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".sweetie-field-progress > li").first()).toBeAttached(LOADED);
  return booked.token as string;
}

/** Type one answer and wait for Sweetie's, counted rather than matched: the words are scripted but not fixed. */
async function answer(page: Page, text: string) {
  const before = await page.locator(BUBBLES).count();
  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  await input.fill(text);
  await input.press("Enter");
  // The patient's bubble and Sweetie's reply: two more than there were.
  await expect(page.locator(BUBBLES)).toHaveCount(before + 2, LOADED);
}

test("reloading the page restores the full transcript and the stepper state (§6.2)", async ({ page }) => {
  const token = await openChatAsPatient(page, "E2E Reload");

  await answer(page, "Mornings keep running high and it worries me before work.");
  await answer(page, "New desk job in August, a cold two weeks ago, sleeping about six hours.");

  const before = await onScreen(page);
  // Greeting, two answers, two replies. Asserted as a number so a lost or duplicated row is a failure here
  // rather than a confusing diff below.
  expect(before.transcript.length).toBe(5);
  expect(before.stepper.some((step) => step.done), "answering filled at least one step").toBe(true);
  await shot(page, "sweetie-before-reload", WHOLE_PAGE);

  // Nothing is kept in the browser: the page holds the transcript in React state and the stepper is computed
  // from the intake. A reload throws both away and rebuilds them from the visit.
  await page.reload();
  await expect(page.locator(BUBBLES)).toHaveCount(before.transcript.length, LOADED);
  await expect(page.locator(".sweetie-field-progress > li").first()).toBeAttached(LOADED);

  const after = await onScreen(page);
  expect(after.transcript, "every message, in the order they were said").toEqual(before.transcript);
  expect(after.stepper, "the same steps, the same one current, the same ones done").toEqual(before.stepper);
  expect(after.progress).toBe(before.progress);
  expect(after.answered).toBe(before.answered);
  await shot(page, "sweetie-after-reload", WHOLE_PAGE);

  // And the server agrees with the screen, which is the point: the page is a view of the visit, not the
  // record of it. page.request, because the verified patient session is in the browser's jar (§5.3).
  const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(bundle.status.answered).toBe(2);
  expect(bundle.intake.turns).toBe(2);
  // `patient.notes` is renderNotes of that same intake, written in the turn's own transaction (§6.2), so
  // what Sour will read and what the stepper shows cannot disagree after a reload.
  expect(bundle.patient.notes, "the notes Sour reads are rendered from that same state").toContain("desk job");
});

test("a reply the browser never receives is still in the transcript after a reload (§6.2)", async ({ page }) => {
  // The crash this stands in for is the ordinary one: the tab is closed, the phone drops its connection, the
  // process serving the page goes away between the commit and the response. The server has done the whole
  // turn; the browser has nothing to show for it. §6.2 says the transcript survives that, and the way it
  // survives is that the turn was committed before the response was ever written.
  const token = await openChatAsPatient(page, "E2E Lost Reply");
  const greeting = await page.locator(BUBBLES).count();

  await page.route("**/api/sweetie", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    // Let it reach the server and finish — the turn is committed by the time this resolves — then drop the
    // answer on the floor instead of handing it back.
    await route.fetch();
    await route.abort();
  });

  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  await input.fill("Lows most afternoons and I have started skipping lunch.");
  await input.press("Enter");

  // What the page does with a failed send: its own apology, which is never stored (app/s/[token]/page.tsx).
  await expect(page.locator(".sweetie-messages")).toContainText(/trouble with that reply/i, LOADED);
  await shot(page, "sweetie-lost-reply", WHOLE_PAGE);

  await page.unroute("**/api/sweetie");
  await page.reload();

  // Greeting, the patient's message, Sweetie's reply. The apology the browser invented is gone, because it
  // was never part of the transcript; the reply the patient never saw is there, because it always was.
  await expect(page.locator(BUBBLES)).toHaveCount(greeting + 2, LOADED);
  const restored = await onScreen(page);
  expect(restored.transcript).toContain("Lows most afternoons and I have started skipping lunch.");
  expect(restored.transcript.join("\n")).not.toMatch(/trouble with that reply/i);
  expect(restored.transcript.filter((line) => line.includes("skipping lunch")).length, "stored once, not twice").toBe(1);
  await shot(page, "sweetie-after-lost-reply", WHOLE_PAGE);

  // One turn's worth of state, not two and not none: the aborted response cost the patient nothing and
  // charged them nothing. And the conversation carries on from there.
  const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(bundle.intake.turns).toBe(1);
  expect(bundle.status.answered).toBe(1);

  await answer(page, "Also tired by mid-morning, and my sleep has been poor since August.");
  const continued = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(continued.intake.turns).toBe(2);
});
