import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { acceptConsent, latestCode, patientEmail, verifyByApi, verifyLink, waitForCode } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T08, design §2.3, §5.3, §5.5: the patient link is a door with a lock on it.
//
// Nothing here is stubbed. The code really is minted by the `notify.code` job and really is "sent" — with no
// SMS or email backend configured, lib/mailer.ts writes it to the mailbox the suite reads (e2e/patient.ts),
// which is the console mailer the ticket asks these to be driven through.

/**
 * A patient with an address to send a code to. Booking is staff's job and needs their session (T06, §5.2), so
 * someone at the practice signs in, books, and signs out again — leaving the browser as a patient's, which is
 * the only thing these tests are about. `contact: false` books a visit with nothing to send a code to, and
 * `contact: "phone"` one whose only contact method is a number no backend here can text (T113).
 */
async function book(page: import("@playwright/test").Page, name: string, contact: boolean | "phone" = true) {
  const email = patientEmail(name);
  // The 555-01xx range the NANP reserves, which is what a demo practice may be given (§13.4, lib/demo.ts).
  const phone = `+1415555${String(Math.floor(Math.random() * 100)).padStart(2, "0")}${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
  const reach = contact === "phone" ? { phone } : contact ? { email } : {};
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", { name, ...reach, visitType: "follow_up", reason: "checking the lock", channel: "none" })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, visitId: booked.visitId as string, email };
}

test("opening a link sends a code and shows the code screen, and the right code opens the chat", async ({ page }) => {
  const { token, email } = await book(page, "E2E Verify");

  // Opening the link is what sends the code (§2.3). The screen says where it went and nothing else: no
  // patient name, no phone number, no address — a forwarded link reveals nothing.
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  // The live note is where the channel is named, and naming the channel is as far as it goes (§2.3).
  await expect(page.locator(".patient-verify-note")).toContainText(/code to your email/i, LOADED);
  await expect(page.locator("body")).not.toContainText("E2E Verify");
  await expect(page.locator("body")).not.toContainText(email);
  await shot(page, "verify-code", WHOLE_PAGE);

  const code = await waitForCode(email);
  // Sweetie's greeting is behind the lock: the chat is not in the page until the code is in.
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);

  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  // The right code opens the consent screen (§2.4, T09), and the one tap there opens the chat. The
  // screenshot stays the chat, which is what this test is about; e2e/consent.spec.ts shoots the screen.
  await expect(page.locator(".patient-consent-card")).toBeVisible(LOADED);
  expect(await acceptConsent(page), "the consent screen was up").toBe(true);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await shot(page, "verify-done", WHOLE_PAGE);

  // 24 hours and bound to the visit (§5.3): the cookie is httpOnly, so the page's own script cannot read it.
  const cookie = (await page.context().cookies()).find((c) => c.name === "ss_patient");
  expect(cookie, "the verified session cookie").toBeTruthy();
  expect(cookie!.httpOnly).toBe(true);
  const hours = (cookie!.expires * 1000 - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23);
  expect(hours).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => document.cookie)).not.toContain("ss_patient");

  // The patient's own summary opens through the same verified link (§2.7), with no second code and no
  // second consent.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
});

test("a wrong code counts down, and the third one invalidates the code for good (§5.3)", async ({ page }) => {
  const { token, email } = await book(page, "E2E Wrong Code");
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  const code = await waitForCode(email);
  const wrong = code === "000000" ? "111111" : "000000";

  for (const left of ["2 tries left", "1 try left"]) {
    await page.getByLabel("6-digit code").fill(wrong);
    await page.getByRole("button", { name: /Continue/i }).click();
    await expect(page.locator(".patient-verify-card .ss-error")).toContainText(left, LOADED);
  }

  // The third wrong try kills the code rather than the attempt: the right digits no longer work either.
  await page.getByLabel("6-digit code").fill(wrong);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.locator(".patient-verify-card .ss-error")).toContainText(/no longer works/i, LOADED);
  await shot(page, "verify-locked", WHOLE_PAGE);

  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.locator(".patient-verify-card .ss-error")).toContainText(/no longer works/i, LOADED);
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);

  // A new code is the only way on, and it works.
  const before = latestCode(email);
  await page.getByRole("button", { name: /Send a new code/i }).click();
  const fresh = await waitForCode(email, undefined, before);
  expect(fresh).not.toBe(code);
  await page.getByLabel("6-digit code").fill(fresh);
  await page.getByRole("button", { name: /Continue/i }).click();
  expect(await acceptConsent(page), "the consent screen was up").toBe(true);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
});

test("the link alone opens nothing: every patient route refuses without a session (§2.3)", async ({ page, request }) => {
  // Booked in `page`, then exercised through `request`, which has never verified anything: exactly the
  // position someone a link was forwarded to is in.
  const { token, email } = await book(page, "E2E Forwarded");

  expect((await request.get(`/api/sweetie?token=${token}`)).status()).toBe(401);
  expect((await request.get(`/api/patient/${token}`)).status()).toBe(401);
  expect((await request.get(`/api/dexcom/status?token=${token}`)).status()).toBe(401);
  const chat = await postJson(request, "/api/sweetie", { token, message: "mornings are rough" });
  expect(chat.status()).toBe(401);
  // The refusal says what to do about it, and nothing about the visit behind it (lib/guard.ts).
  expect((await chat.json()).error).toMatch(/verify your link/i);

  const upload = await request.fetch("/api/upload", { method: "DELETE", data: { token, kind: "dexcom" }, headers: { "x-csrf-token": await csrfToken(request) } });
  expect(upload.status()).toBe(401);

  // None of that wrote anything: once the same context verifies, the intake is still untouched, so the
  // refusals happened before the handler and not after it.
  await verifyByApi(request, token, email);
  const bundle = await (await request.get(`/api/patient/${token}`)).json();
  expect(bundle.status.answered).toBe(0);
});

test("regenerating a link invalidates the old one and the session on it (§5.5)", async ({ page, request, browser }) => {
  // The clinician stays signed in here: replacing a link is theirs to do, behind `visits:invite` (§5.2).
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Regenerated");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Regenerated", email, providerId: demo.id, visitType: "follow_up", reason: "lost the text", channel: "none" })
  ).json();

  // The patient verifies in their own browser; the clinician is in `page`.
  const patient = await browser.newPage();
  const firstCode = await verifyLink(patient, booked.token, email);
  await expect(patient.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  const replaced = await postJson(page.request, "/api/invite", { visitId: booked.visitId, regenerate: true });
  expect(replaced.status()).toBe(202);
  const { link, regenerated } = await replaced.json();
  expect(regenerated).toBe(true);
  expect(link).not.toContain(booked.token);

  // The old token is gone, so it names nothing: the route cannot tell it from any other unknown identifier,
  // and an unknown identifier falls through to the provider branch, which this context has no session for.
  // 401 and 404 both mean "not from here"; what matters is that it is no longer the patient's way in.
  expect((await request.get(`/api/patient/${booked.token}`)).status()).toBe(401);
  // ...and the browser that was already verified on it is out, cookie and all.
  await patient.reload();
  await expect(patient.locator("body")).toContainText(/couldn't find that link/i, LOADED);
  await patient.close();

  // The new link works, with a new code.
  const fresh = new URL(link).pathname.replace("/s/", "");
  const next = await browser.newPage();
  // Same address, second code: wait for the one the new link sends rather than the one still in the mailbox.
  await verifyLink(next, fresh, email, undefined, firstCode);
  await expect(next.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await next.close();
});

test("a link with no phone or email on file says so, and says which practice to call", async ({ page, request }) => {
  // §2.2 has staff record a contact method with the visit. Until one is there a code has nowhere to go, and
  // the honest answer is to send the patient to the office rather than to a screen that cannot work.
  const { token } = await book(page, "E2E No Contact", false);
  await page.goto(`/s/${token}`);
  const card = page.locator(".patient-notice-card");
  await expect(card).toContainText(/no phone number or email address on file/i, LOADED);
  // The screen's next step happens on a telephone, so the page says which number to look up (T98): the
  // practice is on it as the eyebrow the code screen uses, and again inside the sentence that asks for the
  // call. Read as `textContent`, because the eyebrow is uppercased in CSS and the sentence is not.
  const practice = ((await card.locator(".ss-eyebrow").textContent()) ?? "").trim();
  expect(practice, "the practice named above the heading").not.toBe("");
  await expect(card.locator(".ss-lede")).toContainText(practice);
  expect((await postJson(request, "/api/verify", { token })).status()).toBe(422);
  await shot(page, "verify-no-contact", WHOLE_PAGE);
});

test("a link whose only channel has no backend says so, and never claims a code is on its way (T113)", async ({ page, request }) => {
  // The other way into the same dead end, and the one that used to look like it was working: the number is
  // on file, so §2.2 is satisfied, but this environment has no SMS backend — `scripts/agent-check.sh`
  // configures none, which is also what a deployment that has not set §8.1 up looks like. The patient used
  // to be told "We sent a 6-digit code to your phone", with a resend that minted another one into the same
  // silence, because POST /api/verify answered on the strength of a `Job` row alone.
  const { token } = await book(page, "E2E No Backend", "phone");
  await page.goto(`/s/${token}`);
  const card = page.locator(".patient-notice-card");
  await expect(card).toContainText(/nowhere for your 6-digit code to go/i, LOADED);
  // The register of the other two dead ends (T98, components/PatientNotice.tsx): the practice above the
  // heading and again in the sentence that asks for the call, because this screen's next step is a telephone.
  const practice = ((await card.locator(".ss-eyebrow").textContent()) ?? "").trim();
  expect(practice, "the practice named above the heading").not.toBe("");
  await expect(card.locator(".ss-lede")).toContainText(practice);
  // No code box and no resend: there is nothing on this screen that pretends to work.
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send a new code/i })).toHaveCount(0);
  // Nothing on it names the number either, which is the §2.3 rule the working screen keeps as well.
  await expect(page.locator("body")).not.toContainText("+1415555");
  // And the route itself does not answer `sent: true` for a channel that cannot send: 503, because the
  // request is right and the deployment cannot serve it yet.
  const asked = await postJson(request, "/api/verify", { token });
  expect(asked.status()).toBe(503);
  const answer = await asked.json();
  expect(answer.sent).toBeUndefined();
  expect(answer.channels).toEqual([]);
  await shot(page, "verify-no-backend", WHOLE_PAGE);
});

test("a link we do not know says so and reveals nothing about it (§2.3)", async ({ page }) => {
  // The other dead end (T98). A made-up token gets the same screen as a link the practice has replaced —
  // which the regenerate test above drives — and neither can be told from the other here:
  // no practice, no patient, nothing about the token that was tried.
  await page.goto("/s/not-a-real-token");
  const card = page.locator(".patient-notice-card");
  await expect(card).toContainText(/couldn't find that link/i, LOADED);
  await expect(card.locator(".ss-eyebrow")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("not-a-real-token");
  // No code was sent and nothing is on offer: the way back in is the practice, not this page.
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);
  await shot(page, "verify-not-found", WHOLE_PAGE);
});
