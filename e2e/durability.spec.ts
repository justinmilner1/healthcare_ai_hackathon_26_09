import { expect, test, type Page, type Route } from "@playwright/test";
import { postJson } from "./api";
import { MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { expectTranscriptUncut } from "./mobile";
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
  // Every shot of the transcript in this file waits for the region to settle on the newest message first
  // (T106, T83). The assertions above are satisfied by rows being in the DOM; the region then glides to them
  // (§6.4), and a programmatic smooth scroll is not a CSS transition, so `shot()`'s `animations: "disabled"`
  // does not freeze it (T77). Without the wait the shutter opens mid-glide and the PNG shows a message
  // sliced by the composer — a picture of a state the product is never in.
  await expectTranscriptUncut(page, "the transcript before the reload");
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
  // A reload rebuilds the transcript from the visit and the region scrolls itself again, so the rebuilt
  // screen needs the same wait as the one it is being compared with.
  await expectTranscriptUncut(page, "the transcript after the reload");
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
  // The apology is the newest thing in the region, and it is the subject of this frame, so it is the thing
  // the region has to have arrived at before the shutter opens.
  await expectTranscriptUncut(page, "the apology for the lost reply");
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
  await expectTranscriptUncut(page, "the transcript the reload restored");
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

/**
 * The two legs of the opening GET that a slow connection can stretch, and why both are tried.
 *
 * The page merges the opening snapshot with whatever is already on screen, so which leg is slow decides
 * which list holds the turn — and the two orderings fail in opposite directions:
 *
 * - `"response"`: the server answers at once and the bytes arrive late, so its snapshot predates the turn.
 *   Replacing the list with it wiped the patient's message off the screen, which is the bug T78 is about.
 * - `"request"`: the GET reaches the server late, *after* `POST /api/sweetie` committed the turn, so the
 *   snapshot already contains it and the page holds its own copy of the same rows. Concatenating the two
 *   showed the patient their answer and Sweetie's reply twice.
 *
 * Neither is exotic: they are the same slow link, timed differently. Both are asserted rather than
 * described, because the first fix for one of them introduced the other.
 */
const SLOW_LEG = ["response", "request"] as const;

for (const leg of SLOW_LEG) {
  test(`an answer typed before the opening transcript lands survives it arriving, slow ${leg} (§6.2)`, async ({ page }) => {
    // The composer is live while the opening GET is still on the wire, so a patient on a slow connection can
    // answer into what looks like an empty page (T78).
    const token = await openChatAsPatient(page, `E2E Slow ${leg === "response" ? "Open" : "Ask"}`);
    const greeting = await page.locator(BUBBLES).count();

    let hold = true;
    // Matched on the path rather than a glob, because the opening request carries `?token=...` and the turn's
    // POST does not, and only the GET is being held.
    const sweetie = (url: URL) => url.pathname === "/api/sweetie";
    const wait = () => new Promise((resolve) => setTimeout(resolve, 3_000));
    const holdOpening = async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      // Before `route.fetch()` the server has not been asked yet, so the delay is the request leg; after it,
      // the snapshot is already built and the delay is the response leg.
      if (hold && leg === "request") await wait();
      const response = await route.fetch();
      const body = await response.body();
      if (hold && leg === "response") await wait();
      await route.fulfill({ response, body });
    };
    await page.route(sweetie, holdOpening);

    await page.reload();

    // Straight in, while the greeting is still in flight. The input is not disabled, so this is what the
    // product invites the patient to do.
    const mine = "My sugars run high after dinner on the days I work late.";
    const input = page.locator("input[type='text'], input:not([type]), textarea").first();
    await input.fill(mine);
    await input.press("Enter");
    await expect(page.locator(".sweetie-messages")).toContainText(mine, LOADED);

    // The held response now lands. Everything has to be there exactly once: the greeting it carries, and the
    // turn the page took without it.
    await expect(page.locator(BUBBLES)).toHaveCount(greeting + 2, LOADED);
    const settled = await onScreen(page);
    expect(settled.transcript[0], "the greeting the late response carried, first").toMatch(/Hi E2E/);
    expect(settled.transcript, "the patient's own words, kept").toContain(mine);
    expect(
      settled.transcript.filter((line) => line.includes("run high after dinner")).length,
      "the patient's message once — not wiped, and not duplicated by the merge",
    ).toBe(1);
    // Sweetie's reply to it is one row too: the snapshot can hold a copy of that as well.
    expect(
      settled.transcript.filter((line) => /Since you last saw the doctor/.test(line)).length,
      "Sweetie's reply once",
    ).toBe(1);
    // And the stepper is where the turn left it, not rolled back to the snapshot's older state.
    expect(settled.stepper.some((step) => step.done), "the answered step stayed answered").toBe(true);
    if (leg === "response") {
      // The merge above has just rewritten the list, which moves the region again.
      await expectTranscriptUncut(page, "the answer typed before the opening transcript landed");
      await shot(page, "sweetie-answer-before-load");
    }

    hold = false;
    await page.unroute(sweetie, holdOpening);

    // The server was never in doubt — one turn, stored — so a reload agrees with what stayed on screen.
    // This is the assertion that catches a duplicate: the screen is only right if it matches the record.
    const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
    expect(bundle.intake.turns).toBe(1);
    await page.reload();
    await expect(page.locator(BUBBLES)).toHaveCount(greeting + 2, LOADED);
    const reloaded = await onScreen(page);
    expect(reloaded.transcript, "the same transcript the race left behind").toEqual(settled.transcript);
  });
}
