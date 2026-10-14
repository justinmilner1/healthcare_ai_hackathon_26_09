import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";
import { latestCode, patientEmail, verifyByApi, verifyLink, waitForCode } from "./patient";

// T08, design §2.3, §5.3, §5.5: the patient link is a door with a lock on it.
//
// Nothing here is stubbed. The code really is minted by the `notify.code` job and really is "sent" — with no
// SMS or email backend configured, lib/mailer.ts writes it to the mailbox the suite reads (e2e/patient.ts),
// which is the console mailer the ticket asks these to be driven through.

const LOADED = { timeout: 30_000 };

/** A patient with an address to send a code to, booked against the seeded demo provider. */
async function book(request: import("@playwright/test").APIRequestContext, name: string) {
  const email = patientEmail(name);
  const booked = await (
    await postJson(request, "/api/book", { name, email, visitType: "follow_up", reason: "checking the lock", optIn: false })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  return { token: booked.token as string, visitId: booked.visitId as string, email };
}

test("opening a link sends a code and shows the code screen, and the right code opens the chat", async ({ page, request }) => {
  const { token, email } = await book(request, "E2E Verify");

  // Opening the link is what sends the code (§2.3). The screen says where it went and nothing else: no
  // patient name, no phone number, no address — a forwarded link reveals nothing.
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  await expect(page.locator(".patient-verify-card")).toContainText(/code we just sent to your email/i);
  await expect(page.locator("body")).not.toContainText("E2E Verify");
  await expect(page.locator("body")).not.toContainText(email);
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-verify-code.png`, fullPage: true });

  const code = await waitForCode(email);
  // Sweetie's greeting is behind the lock: the chat is not in the page until the code is in.
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);

  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-verify-done.png`, fullPage: true });

  // 24 hours and bound to the visit (§5.3): the cookie is httpOnly, so the page's own script cannot read it.
  const cookie = (await page.context().cookies()).find((c) => c.name === "ss_patient");
  expect(cookie, "the verified session cookie").toBeTruthy();
  expect(cookie!.httpOnly).toBe(true);
  const hours = (cookie!.expires * 1000 - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23);
  expect(hours).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => document.cookie)).not.toContain("ss_patient");

  // The patient's own summary opens through the same verified link (§2.7), with no second code.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
});

test("a wrong code counts down, and the third one invalidates the code for good (§5.3)", async ({ page, request }) => {
  const { token, email } = await book(request, "E2E Wrong Code");
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  const code = await waitForCode(email);
  const wrong = code === "000000" ? "111111" : "000000";

  for (const left of ["2 tries left", "1 try left"]) {
    await page.getByLabel("6-digit code").fill(wrong);
    await page.getByRole("button", { name: /Continue/i }).click();
    await expect(page.getByRole("alert")).toContainText(left, LOADED);
  }

  // The third wrong try kills the code rather than the attempt: the right digits no longer work either.
  await page.getByLabel("6-digit code").fill(wrong);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.getByRole("alert")).toContainText(/no longer works/i, LOADED);
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-verify-locked.png`, fullPage: true });

  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.getByRole("alert")).toContainText(/no longer works/i, LOADED);
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);

  // A new code is the only way on, and it works.
  const before = latestCode(email);
  await page.getByRole("button", { name: /Send a new code/i }).click();
  const fresh = await waitForCode(email, undefined, before);
  expect(fresh).not.toBe(code);
  await page.getByLabel("6-digit code").fill(fresh);
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
});

test("the link alone opens nothing: every patient route refuses without a session (§2.3)", async ({ request }) => {
  const { token, email } = await book(request, "E2E Forwarded");

  // This request context never verified, so it is exactly the position someone a link was forwarded to is in.
  expect((await request.get(`/api/sweetie?token=${token}`)).status()).toBe(401);
  expect((await request.get(`/api/patient/${token}`)).status()).toBe(401);
  expect((await request.get(`/api/dexcom/status?token=${token}`)).status()).toBe(401);
  const chat = await postJson(request, "/api/sweetie", { token, message: "mornings are rough" });
  expect(chat.status()).toBe(401);
  expect((await chat.json()).code).toBe("verification_required");

  const upload = await request.fetch("/api/upload", { method: "DELETE", data: { token, kind: "dexcom" }, headers: { "x-csrf-token": await csrfToken(request) } });
  expect(upload.status()).toBe(401);

  // None of that wrote anything: once the same context verifies, the intake is still untouched, so the
  // refusals happened before the handler and not after it.
  await verifyByApi(request, token, email);
  const bundle = await (await request.get(`/api/patient/${token}`)).json();
  expect(bundle.status.answered).toBe(0);
});

test("regenerating a link invalidates the old one and the session on it (§5.5)", async ({ page, request, browser }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Regenerated");
  const booked = await (
    await postJson(page.request, "/api/book", { name: "E2E Regenerated", email, providerId: demo.id, visitType: "follow_up", reason: "lost the text", optIn: false })
  ).json();

  // The patient verifies in their own browser; the clinician is in `page`.
  const patient = await browser.newPage();
  await verifyLink(patient, booked.token, email);
  await expect(patient.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  const replaced = await postJson(page.request, "/api/invite", { visitId: booked.visitId, regenerate: true });
  expect(replaced.status()).toBe(202);
  const { link, regenerated } = await replaced.json();
  expect(regenerated).toBe(true);
  expect(link).not.toContain(booked.token);

  // The old token is gone, so the old link is not a link any more...
  expect((await request.get(`/api/patient/${booked.token}`)).status()).toBe(404);
  // ...and the browser that was already verified on it is out, cookie and all.
  await patient.reload();
  await expect(patient.locator("body")).toContainText(/couldn't find that link/i, LOADED);
  await patient.close();

  // The new link works, with a new code.
  const fresh = new URL(link).pathname.replace("/s/", "");
  const next = await browser.newPage();
  await verifyLink(next, fresh, email);
  await expect(next.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await next.close();
});

test("a link with no phone or email on file says so instead of showing a code screen", async ({ page, request }) => {
  // §2.2 has staff record a contact method with the visit. Until one is there a code has nowhere to go, and
  // the honest answer is to send the patient to the office rather than to a screen that cannot work.
  const booked = await (await postJson(request, "/api/book", { name: "E2E No Contact", visitType: "follow_up", optIn: false })).json();
  await page.goto(`/s/${booked.token}`);
  await expect(page.locator(".patient-state-card")).toContainText(/no phone number or email address on file/i, LOADED);
  expect((await postJson(request, "/api/verify", { token: booked.token })).status()).toBe(422);
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-verify-no-contact.png`, fullPage: true });
});
