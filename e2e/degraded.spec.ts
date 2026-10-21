import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { DEGRADED_MAIL_DIR, MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { expectTranscriptUncut } from "./mobile";
import { patientEmail, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// Design 6.3 / 11.3: when the model gateway is down Sweetie answers from the scripted path and the page says so.
// Two servers, started by playwright.config.ts, are the whole fixture; nothing in the app is stubbed.
//
//   port+1  a key is configured and OPENAI_BASE_URL points at a closed loopback port, so every call is refused
//   port    no key at all: the offline demo the rest of the suite runs against
//
// Both are needed, because the interesting claim is that the page tells them apart. A patient on an offline
// demo gets the "Demo mode" badge; only a real outage gets the note.

const PORT = Number(process.env.E2E_PORT ?? 3100);

/** The scripted second question, from UPDATE.default.fallbackQuestion in lib/sweetie.ts. */
const SCRIPTED_FOLLOW_UP = /Since you last saw the doctor/;

async function bookAndOpen(page: Page, name: string, mailDir: string) {
  // Booking is behind the session and the staff role now (§5.2), so the visit starts with someone at the
  // practice signing in — on whichever of the two servers this describe block is pointed at, which is why the
  // mailbox is a parameter: each server writes its sign-in links only to its own (playwright.config.ts).
  // postJson adds the CSRF header the way the dashboard does (§10.8, e2e/api.ts), and takes page.request so
  // it posts as the signed-in provider.
  await signInAsDemo(page, { mailDir });
  // The patient's six-digit code goes to this address (T08, §5.3), and it lands in the same mailbox.
  const email = patientEmail(name);
  const booked = await (
    await postJson(page.request, "/api/book", { name, email, visitType: "follow_up", reason: "numbers all over the place", channel: "none" })
  ).json();
  expect(booked.token).toBeTruthy();

  // What this spec is about is the patient side of a model outage, and the patient has no provider session:
  // the link plus a code is their whole credential (§5.3). So the provider's is dropped before the page is
  // opened, and the patient verifies the way a patient does.
  await signOutOfBrowser(page);
  await verifyLink(page, booked.token, email, mailDir);
  // The greeting needs no model, so it is the same on both servers and marks the page as loaded.
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  return booked.token as string;
}

async function answerFirstQuestion(page: Page) {
  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  await input.fill("My readings jump around after lunch and I want to know why.");
  await input.press("Enter");
}

test.describe("model gateway unreachable", () => {
  test.use({ baseURL: `http://localhost:${PORT + 1}` });

  test("Sweetie keeps asking from the scripted path and the page says the assistant is unavailable", async ({ page }) => {
    const token = await bookAndOpen(page, "E2E Degraded", DEGRADED_MAIL_DIR);
    const note = page.locator(".sweetie-degraded-note");

    await answerFirstQuestion(page);

    // The patient's first message is the first model call, so it is also the first failure. (The note may
    // already be showing: the circuit is per server process, and an earlier project's run opened it.)
    await expect(note).toBeVisible(LOADED);
    await expect(note).toContainText(/assistant is unavailable/i);

    // "The questions continue": the scripted second question arrives, and the answer was stored.
    await expect(page.locator(".sweetie-messages")).toContainText(SCRIPTED_FOLLOW_UP, LOADED);
    // `toContainText` is satisfied the moment the words are in the DOM, and the transcript then glides to
    // them (§6.4) — a glide `shot()`'s `animations: "disabled"` cannot freeze, because a programmatic smooth
    // scroll is not a CSS transition (T77). Both of this spec's frames used to be taken during it, with the
    // scripted question they had just asserted sliced by the composer on the desktop and out of the frame
    // altogether at 375px. So the shot waits for the region to settle on the newest message the same way the
    // other conversation specs do (T106, T83) — a poll on the region rather than a sleep, which also means a
    // region that never lands fails here, naming the page, instead of being waited out.
    await expectTranscriptUncut(page, "the scripted question with the gateway down");
    await shot(page, "sweetie-degraded", WHOLE_PAGE);

    // page.request: the verified patient session lives in the browser's cookie jar (T08, §5.3).
    const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
    expect(bundle.status.answered).toBeGreaterThanOrEqual(1);
  });
});

test.describe("no model configured", () => {
  test.use({ baseURL: `http://localhost:${PORT}` });

  test("the offline demo is not an outage: same scripted questions, no degraded note", async ({ page }) => {
    await bookAndOpen(page, "E2E Scripted", MAIL_DIR);
    await answerFirstQuestion(page);

    await expect(page.locator(".sweetie-messages")).toContainText(SCRIPTED_FOLLOW_UP, LOADED);
    await expect(page.locator(".sweetie-degraded-note")).toBeHidden();
  });
});
