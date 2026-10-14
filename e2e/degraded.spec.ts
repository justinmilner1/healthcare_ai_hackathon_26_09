import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Design 6.3 / 11.3: when the model gateway is down Sweetie answers from the scripted path and the page says so.
// Two servers, started by playwright.config.ts, are the whole fixture; nothing in the app is stubbed.
//
//   port+1  a key is configured and OPENAI_BASE_URL points at a closed loopback port, so every call is refused
//   port    no key at all: the offline demo the rest of the suite runs against
//
// Both are needed, because the interesting claim is that the page tells them apart. A patient on an offline
// demo gets the "Demo mode" badge; only a real outage gets the note.

const PORT = Number(process.env.E2E_PORT ?? 3100);
const LOADED = { timeout: 30_000 };

/** The scripted second question, from UPDATE.default.fallbackQuestion in lib/sweetie.ts. */
const SCRIPTED_FOLLOW_UP = /Since you last saw the doctor/;

async function bookAndOpen(page: Page, request: APIRequestContext, name: string) {
  // No providerId: /api/book books against the seeded demo provider, so this spec needs no sign-in. What it
  // is about is the patient side of a model outage, and /s/<token> is the patient's own credential (§5.3).
  const booked = await (
    await request.post("/api/book", {
      data: { name, visitType: "follow_up", reason: "numbers all over the place", optIn: false },
    })
  ).json();
  expect(booked.token).toBeTruthy();

  await page.goto(`/s/${booked.token}`);
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

  test("Sweetie keeps asking from the scripted path and the page says the assistant is unavailable", async ({ page, request }) => {
    const token = await bookAndOpen(page, request, "E2E Degraded");
    const note = page.locator(".sweetie-degraded-note");

    await answerFirstQuestion(page);

    // The patient's first message is the first model call, so it is also the first failure. (The note may
    // already be showing: the circuit is per server process, and an earlier project's run opened it.)
    await expect(note).toBeVisible(LOADED);
    await expect(note).toContainText(/assistant is unavailable/i);

    // "The questions continue": the scripted second question arrives, and the answer was stored.
    await expect(page.locator(".sweetie-messages")).toContainText(SCRIPTED_FOLLOW_UP, LOADED);
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-sweetie-degraded.png`, fullPage: true });

    const bundle = await (await request.get(`/api/patient/${token}`)).json();
    expect(bundle.status.answered).toBeGreaterThanOrEqual(1);
  });
});

test.describe("no model configured", () => {
  test.use({ baseURL: `http://localhost:${PORT}` });

  test("the offline demo is not an outage: same scripted questions, no degraded note", async ({ page, request }) => {
    await bookAndOpen(page, request, "E2E Scripted");
    await answerFirstQuestion(page);

    await expect(page.locator(".sweetie-messages")).toContainText(SCRIPTED_FOLLOW_UP, LOADED);
    await expect(page.locator(".sweetie-degraded-note")).toBeHidden();
  });
});
