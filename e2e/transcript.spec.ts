import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { expectTranscriptUncut } from "./mobile";
import { patientEmail, verifyLink } from "./patient";

// T117, design §12.2/§12.4: the one spec whose subject is `expectTranscriptUncut` itself rather than a
// screen.
//
// Five specs call that helper, at fourteen call sites, to decide whether a committed screenshot is of a
// finished transcript or of a scroll caught mid-flight, so its own contract is load-bearing — and it is a
// contract about *timing*, which is the one thing the specs that call it cannot check. They each wait for
// their final card and then ask whether it is uncut; none of them can say what the helper would do if the
// transcript moved underneath it, because none of them makes it move. The reviewer run of 2026-10-21 is
// what that costs: the helper waited a pixel looser than it asserted, nothing in the suite was looking at
// the helper, and a red `main` is how it surfaced.
//
// So this file makes the transcript move on purpose, in three stagings and five tests. Every one of them
// runs in both projects: the helper's room check is the phone's alone, but the wait is the whole subject
// here and it is the same wait at either width.
//
// The motion is the file's own rather than the stylesheet's, and that is deliberate. A real message arrives
// under `messageIn`, a 340ms entrance that translates it 8px (app/globals.css) — real, but 8 pixels over
// 340 milliseconds is too small and too brief a window to aim a test at. So a message here is placed with
// an inline transform the staging clears on its own clock, which makes how far out of place the newest
// message is, and the moment it arrives, both numbers this file chose. `getBoundingClientRect` reads an
// inline transform exactly as it reads an animation's, which is what makes the stand-in honest: the same
// measurement going wrong in the same way, at a size and a moment a test can assert on.
//
// One thing no test here reproduces, and it is worth saying where a reader will look for it. The window the
// ticket is about — between the old helper's poll accepting a reading and its second, independent
// measurement — is one `evaluate` round trip wide, and no timer can be aimed at it. That window is closed
// structurally rather than covered: there is no second read for anything to land in. What these tests pin is
// the contract that makes the closure observable, which is the measurement the helper now reports: which
// message it settled on, and whether that message was still moving when it did.

/** A verified check-in with Sweetie's opener on the screen — the settled transcript each test starts from. */
async function checkIn(page: Page, name: string): Promise<void> {
  await signInAsDemo(page);
  const email = patientEmail(name);
  const booked = await (
    await postJson(page.request, "/api/book", {
      name,
      email,
      visitType: "follow_up",
      reason: "mornings running high",
      channel: "none",
    })
  ).json();
  expect(booked.token, "the visit's invite token").toBeTruthy();
  await signOutOfBrowser(page);

  await verifyLink(page, booked.token, email);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
}

/**
 * How far below the bottom of the region an appended message is parked, in CSS pixels.
 *
 * Measured from the fold rather than from where the message belongs, which is not the same thing: on the
 * desktop the opener does not fill the region, so a message appended under it starts a couple of hundred
 * pixels *above* the fold and an offset counted from its own resting place left it there. Far enough past
 * the fold that no rounding can reach it, and close enough that the branch under test is still the one for
 * a message the region could hold whole.
 */
const OUT_OF_PLACE = 120;

/**
 * Append a message to the transcript, parked `offset` pixels below the bottom of the region.
 *
 * `settleAfter` is when it arrives, in milliseconds, or `null` for a message that never does. The return
 * value is the state at the moment it was appended — the reading the helper must not report as a settled
 * one: whether the message is the newest thing in the region, how far below the fold it is sitting, and
 * whether the region could hold it whole.
 *
 * That last one is what decides which half of the helper this stages. `settling` is `above + below`, two
 * rect readings, for a message that fits and an `offsetTop` reading for one that does not — and `offsetTop`
 * is layout, which a transform cannot move. So a stand-in placed with a transform can only exercise the
 * first, the half the reviewer run of 2026-10-21 failed in, and every test built on this asserts `fits`
 * rather than assuming it: a region that shrank until a one-line message no longer fitted it would otherwise
 * turn those tests silently into passes about nothing.
 *
 * Two details keep the stand-in in step with the product. It carries `.sweetie-message-row`, so its width,
 * padding and line height are a real message's and `fits` is answered on a real message's height — but with
 * that class's 340ms `messageIn` animation switched off, because a CSS animation outranks an inline style
 * and would otherwise drive the very transform this is using to place the node. And the region is parked at
 * its end by hand: the page scrolls itself only when React's own message list changes
 * (app/s/[token]/page.tsx), and this row is not in that list, so without it the transcript would sit where
 * the opener left it.
 */
async function appendOutOfPlace(
  page: Page,
  words: string,
  settleAfter: number | null,
  offset: number = OUT_OF_PLACE,
): Promise<{ last: boolean; below: number; above: number; fits: boolean; height: number; region: number }> {
  return page.locator(".sweetie-messages").evaluate(
    (element, { words, settleAfter, offset }) => {
      const row = document.createElement("div");
      row.className = "sweetie-message-row";
      const bubble = document.createElement("p");
      bubble.className = "sweetie-message";
      bubble.textContent = words;
      row.appendChild(bubble);
      row.style.animation = "none";
      element.appendChild(row);
      // `behavior: "auto"`: `.sweetie-messages` is `scroll-behavior: smooth`, and a glide of this test's own
      // would be a second thing in flight on top of the one it is staging.
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      // Where it belongs, before it is moved: the gap from its own bottom edge to the fold, which is 0 on a
      // region the conversation fills and the empty rest of the region on one it does not.
      const fold = element.getBoundingClientRect().bottom;
      row.style.transform = `translateY(${fold - row.getBoundingClientRect().bottom + offset}px)`;
      if (settleAfter !== null) {
        setTimeout(() => {
          row.style.transform = "";
          element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        }, settleAfter);
      }
      const box = row.getBoundingClientRect();
      const region = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      return {
        last: element.lastElementChild === row,
        below: Math.round(box.bottom - region.bottom),
        above: Math.round(region.top - box.top),
        fits: box.height + padding <= element.clientHeight + 1,
        height: Math.round(box.height),
        region: Math.round(region.height),
      };
    },
    { words, settleAfter, offset },
  );
}

/**
 * The helper reports the message it settled on, not one that arrived after it (T117).
 *
 * This is the second read the T117 repair left open. The old helper polled until the transcript had
 * settled, then measured a *second* time and asserted on that — so anything appended between the two calls
 * made `lastElementChild` a different node, and the assertions described that node's entrance as though it
 * were the state the poll had accepted. The helper now asserts on the reading the poll took, and reports it,
 * which is what lets this test name which message that was.
 */
test("the transcript helper settles on the message that arrived while it waited", async ({ page }) => {
  await checkIn(page, "E2E Transcript Arrival");

  // The state the old helper would have polled to and then re-measured past.
  const opener = await expectTranscriptUncut(page, "Sweetie's opener");
  expect(opener.below, "the opener is not in the region whole, so there is no settled state to start from").toBe(0);
  expect(opener.fits, "the opener does not fit this region, so the branch this test is about is not the one it takes").toBe(true);

  const words = "A second message, arriving while the helper is waiting.";
  const arrival = await appendOutOfPlace(page, words, 600);
  expect(arrival.last, "the appended message is not the newest thing in the transcript").toBe(true);
  expect(
    arrival.fits,
    `the appended message is ${arrival.height}px in a ${arrival.region}px region, which the helper answers from \`offsetTop\` — a reading no transform moves, so this stages nothing`,
  ).toBe(true);
  // The race exists: at the moment it was appended the newest message was well below the fold, which is the
  // reading `expect(fit.below).toBe(0)` would have been handed.
  expect(
    arrival.below,
    `the appended message is already in place (${arrival.below}px below the fold), so this test stages nothing for the helper to wait out`,
  ).toBeGreaterThan(1);

  const fit = await expectTranscriptUncut(page, "the message that arrived while the helper waited");
  // It is the new message the helper settled on, not the opener it could still see sitting correctly.
  expect(fit.text, "the helper reported a message other than the one that arrived").toContain("A second message");
  expect(fit.identity, "the helper settled on the opener rather than on what arrived after it").not.toBe(opener.identity);
  // And on its arrival, not on the flight the reading above caught it in.
  expect(fit.settling, "the helper settled on a message still in flight").toBe(0);
  expect(fit.below, "the helper settled on a message still cut off at the bottom of the region").toBe(0);
  expect(fit.above, "the helper settled on a message cut off at the top of the region").toBe(0);
});

/**
 * Several messages, arriving one after another, none of them in place until the last.
 *
 * `appendOutOfPlace` above stages the arrival the helper has not started waiting for yet; this stages the
 * one it is already in the middle of. The first message is placed before this resolves, so the helper's very
 * first reading is of a transcript in motion whichever millisecond it lands on, and the rest are placed
 * `every` milliseconds after that from the page's own timers rather than over the wire, where a round trip
 * could put them anywhere. Nothing is in place until `settleAfter` milliseconds after the last one appears,
 * so there is no moment in the sequence at which the helper could legitimately accept anything earlier.
 */
async function stageArrivals(page: Page, words: string[], every: number, settleAfter: number): Promise<void> {
  await page.locator(".sweetie-messages").evaluate(
    (element, { words, every, settleAfter, offset }) => {
      const place = (text: string) => {
        const row = document.createElement("div");
        row.className = "sweetie-message-row";
        const bubble = document.createElement("p");
        bubble.className = "sweetie-message";
        bubble.textContent = text;
        row.appendChild(bubble);
        row.style.animation = "none";
        element.appendChild(row);
        element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        const fold = element.getBoundingClientRect().bottom;
        row.style.transform = `translateY(${fold - row.getBoundingClientRect().bottom + offset}px)`;
        return row;
      };
      const arrive = (row: HTMLElement) =>
        setTimeout(() => {
          row.style.transform = "";
          element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        }, settleAfter);
      const last = words.length - 1;
      // The first one now, so that the helper cannot take a reading of the settled transcript this started
      // from; the rest on the page's own clock.
      if (last === 0) arrive(place(words[0]));
      else place(words[0]);
      for (let i = 1; i <= last; i++) {
        const text = words[i];
        setTimeout(() => {
          const row = place(text);
          if (i === last) arrive(row);
        }, i * every);
      }
    },
    { words, every, settleAfter, offset: OUT_OF_PLACE },
  );
}

/**
 * Messages that keep arriving are waited out, and the last of them is what the helper reports (T117).
 *
 * The criterion the test above cannot reach: there, the second message is in the transcript before the
 * helper is called, so a helper that simply reported the first settled state it found would still name the
 * right one. Here three arrive while it is waiting, and only the third ever comes to rest — so the message
 * the helper reports is the one its wait actually watched, and naming the first or the second would be the
 * defect this ticket is about rather than a near miss.
 */
test("the transcript helper waits out messages that keep arriving, and reports the last of them", async ({ page }) => {
  await checkIn(page, "E2E Transcript Churn");
  await expectTranscriptUncut(page, "Sweetie's opener");

  await stageArrivals(page, ["The first of three arrivals.", "The second of three arrivals.", "The third of three arrivals."], 250, 400);

  const fit = await expectTranscriptUncut(page, "a transcript that kept changing underneath the wait");
  expect(fit.text, "the helper reported a message other than the last one to arrive").toContain("The third of three");
  expect(fit.settling, "the helper settled on a message still in flight").toBe(0);
  expect(fit.below, "the helper settled on a message still cut off at the bottom of the region").toBe(0);
  expect(fit.above, "the helper settled on a message cut off at the top of the region").toBe(0);
});

/**
 * Messages arriving faster than the wait can confirm one, each of them in place the instant it appears.
 *
 * Every other staging here is about a transcript in motion. This one is about a transcript that is never in
 * motion and never the same twice: each message is placed where it belongs, so any single reading of it is a
 * settled reading, and the next message has replaced it before the wait can confirm that one was still the
 * newest. It runs on an interval rather than a fixed list so that no number of poll attempts can outlast it,
 * and stops after `stopAfter` so that a page kept open past the budget does not go on appending for the rest
 * of the suite. That figure is a page-side staging duration, not a wait budget — nothing here is waiting on
 * it — and it is several times the `expect` budget the poll under test runs on.
 */
async function stageEndlessArrivals(page: Page, every: number, stopAfter: number): Promise<void> {
  await page.locator(".sweetie-messages").evaluate(
    (element, { every, stopAfter }) => {
      let n = 0;
      const place = () => {
        const row = document.createElement("div");
        row.className = "sweetie-message-row";
        const bubble = document.createElement("p");
        bubble.className = "sweetie-message";
        // Numbered, because identity is content here: two messages reading the same would be one message as
        // far as the wait is concerned, which is exactly the judgement under test.
        bubble.textContent = `Arrival number ${++n}, already where it belongs.`;
        row.appendChild(bubble);
        row.style.animation = "none";
        element.appendChild(row);
        element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      };
      place();
      const timer = setInterval(place, every);
      setTimeout(() => clearInterval(timer), stopAfter);
    },
    { every, stopAfter },
  );
}

/**
 * A transcript whose newest message keeps changing fails the helper, and the failure says that is why (T117).
 *
 * The other half of the criterion the test above covers: there the helper fails because nothing ever comes to
 * rest, which a helper with no notion of identity would also report. Here everything comes to rest — each
 * message is in place from the moment it appears, so every single reading of this transcript is a settled one
 * — and what is wrong is that it is never the same message twice. A wait that accepted the first settled
 * reading it found would pass this and report a message two or three arrivals out of date as the newest
 * thing the patient can see. The helper has to notice, and to say what it noticed.
 */
test("the transcript helper fails on a transcript whose newest message keeps changing, and says so", async ({ page }) => {
  await checkIn(page, "E2E Transcript Stream");
  await expectTranscriptUncut(page, "Sweetie's opener");

  await stageEndlessArrivals(page, 120, 20_000);

  const failure = await expectTranscriptUncut(page, "a transcript that never holds still").then(
    () => null,
    (error: Error) => error.message,
  );
  expect(
    failure,
    "the helper settled on one of a stream of messages, each already out of date when it was read",
  ).toContain("the transcript never settled on the newest message");
  // And the value it reports names the reason, so a reader is not left measuring pixels: what went wrong is
  // the arrivals, not the geometry of any one of them.
  expect(
    failure,
    "the helper reported the stream as a message still in motion, which is the one thing none of them was",
  ).toContain("arrived while the wait was running");
});

/**
 * A newest message that never arrives fails the helper, rather than being reported as settled (T117).
 *
 * Where the two tests above show the helper waiting an arrival out, these show what it does when the wait
 * cannot be satisfied: it has to fail, and it has to fail saying the transcript never settled.
 *
 * The second of the two is the reviewer run of 2026-10-21 staged on purpose. A message parked exactly one
 * pixel short of where it belongs is the state that run died in, and it is the state the two halves of this
 * helper used to disagree about: the poll accepted `settling <= 1` and the assertion under it demanded
 * `below === 0`, so the helper accepted a glide and then rejected the reading of it — reporting a transcript
 * cut off at the bottom of the region on a product that had done nothing wrong. Both halves draw the line in
 * the same place now, which is what the last assertion here is about: a pixel out is a wait that has not
 * finished, never a verdict on the page. `1da6768` is the commit that closed that gap; this is what keeps it
 * closed.
 *
 * A single pixel is safe to park a message on to the pixel, because the transform is computed from the very
 * rect it is correcting and in the same units: the row's bottom edge lands on the fold plus one, not near it.
 * The test asserts that before it asks anything of the helper, so a browser that rounded it away would say
 * so rather than quietly becoming a test about nothing.
 */
for (const { what, offset, subject } of [
  { what: "never lands", offset: OUT_OF_PLACE, subject: "a message that never lands at all" },
  { what: "lands a pixel short", offset: 1, subject: "a message one pixel short of where it belongs" },
]) {
  test(`the transcript helper fails on a newest message that ${what}`, async ({ page }) => {
    await checkIn(page, `E2E Transcript ${offset === 1 ? "Pixel" : "Stuck"}`);
    await expectTranscriptUncut(page, "Sweetie's opener");

    const stuck = await appendOutOfPlace(page, `This is ${subject}.`, null, offset);
    expect(stuck.last, "the stuck message is not the newest thing in the transcript").toBe(true);
    expect(
      stuck.fits,
      `the stuck message is ${stuck.height}px in a ${stuck.region}px region, which the helper answers from \`offsetTop\` — a reading no transform moves, so it would settle at once`,
    ).toBe(true);
    expect(
      stuck.below,
      `the stuck message is ${stuck.below}px below the fold rather than the ${offset}px this test parked it at`,
    ).toBe(offset);

    // `then` with both arms rather than `rejects`, so that a helper which *passed* is a failure this test
    // reports in its own words rather than one Playwright reports as a missing rejection.
    const failure = await expectTranscriptUncut(page, subject).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(
      failure,
      "the helper passed on a message that never stopped moving, or failed for some other reason",
    ).toContain("the transcript never settled on the newest message");
    // And it failed as a wait that ran out, not as a verdict on the page: the assertions under the poll
    // never ran, because the poll never handed them anything to run on.
    expect(
      failure,
      "the helper reported the page as cut off at the bottom of the region, which is the 2026-10-21 failure itself: a poll that accepted a state its own assertion then rejected",
    ).not.toContain("is still cut off at the bottom of it");
  });
}
