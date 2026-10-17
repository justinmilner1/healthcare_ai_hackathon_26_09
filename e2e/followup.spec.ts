import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { MAIL_DIR, signInAsDemo } from "./auth";
import { patientEmail, verifyByApi } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T18 (design §2.6, §7.5): "Follow-up questions to Sour are logged with the clinician id and the answer,
// visible on the page, never emailed."
//
// The three claims, on the running app. The one thing this suite cannot show is an answer arriving: there is
// no model on any of the servers playwright.config.ts starts (that is the point of them), so a question
// asked here is one the gateway refuses. That turns out to be the more interesting half of §7.5 anyway —
// the question is written before the model is called, so an outage is exactly when a log that is only page
// state loses what a clinician asked. The seeded visit carries an answered follow-up (scripts/seed.ts) for
// the other shape, which the last test reads.
//
// The uploads go through `request` and not `page.request`: the patient's credential is the token plus the
// verified session the six-digit code leaves behind (§5.3), and keeping them in separate contexts means the
// provider session stays signed in for the half of the test that is the clinician's.

const LOADED = { timeout: 30_000 };
const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

const QUESTION = "Which of the overnight highs followed a late dinner out?";

/** Every message the local mailer has "sent" (design §5.1, lib/mailer.ts), as one blob. */
function mailbox(dir = MAIL_DIR): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt"));
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
}

test("a follow-up question is logged with the clinician and the time, survives a reload, and is never emailed", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Followup");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Followup", email, providerId: demo.id, visitType: "follow_up", reason: "overnight highs", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId).toBeTruthy();

  // Something for Sour to be asked about. The patient's own side, in its own context (§5.3).
  await verifyByApi(request, booked.token, email);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(uploaded.ok(), `POST /api/upload: ${uploaded.status()}`).toBeTruthy();

  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Followup", LOADED);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", LOADED);

  // Nothing has been asked about this visit yet, so the panel is empty rather than carrying another visit's.
  await expect(page.locator(".sour-followup")).toHaveCount(0);

  await page.locator("input[aria-label='Message Sour']").fill(QUESTION);
  await page.locator(".sour-ask-card form button").click();

  // §7.5 on the screen: the question, the clinician who asked it, and when. There is no model here, so the
  // answer never arrives — and the question is on the record all the same, which is what writing it before
  // the call buys (lib/followUps.ts).
  const logged = page.locator(".sour-followup").first();
  await expect(logged).toContainText(QUESTION, LOADED);
  await expect(logged).toContainText("Dr. Demo Endo");
  await expect(logged).toContainText(/today at/i);
  await expect(logged.locator(".sour-answer-unanswered")).toContainText(/No answer recorded/i);
  await expect(page.locator(".sour-ask-card .ss-error")).toContainText(/Sour chat is unavailable/i);
  await shot(page, "provider-sour-followup", WHOLE_PAGE);

  // It is a row and not a piece of page state: a fresh load of the one-pager reads the same question back.
  await page.reload();
  const reloaded = page.locator(".sour-followup").first();
  await expect(reloaded).toContainText(QUESTION, LOADED);
  await expect(reloaded).toContainText("Dr. Demo Endo");

  // The log behind it (§7.5): the clinician id, the time, the question, and no answer.
  const log = (await (await page.request.get(`/api/sour?visitId=${booked.visitId}`)).json()) as {
    followUps: { id: string; at: string; by: string; byName: string; question: string; answer: string | null }[];
  };
  expect(log.followUps.length).toBe(1);
  expect(log.followUps[0].by).toBe(demo.id);
  expect(log.followUps[0].byName).toBe("Dr. Demo Endo");
  expect(log.followUps[0].question).toBe(QUESTION);
  expect(log.followUps[0].answer).toBe(null);
  expect(Date.parse(log.followUps[0].at)).toBeGreaterThan(Date.now() - 10 * 60_000);

  // §10.2's row for it, on the practice's audit log: one per question, the clinician as the actor, and the
  // question itself nowhere in it (§4.8 keeps `detail` free of anything a sentence can hide in).
  const audit = (await (await page.request.get(`/api/audit?entityId=${booked.visitId}&action=summary.question`)).json()) as {
    entries: { actorId: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> | null }[];
  };
  expect(audit.entries.length).toBe(1);
  expect(audit.entries[0].actorId).toBe(demo.id);
  expect(audit.entries[0].entityType).toBe("visit");
  expect(audit.entries[0].entityId).toBe(booked.visitId);
  expect(JSON.stringify(audit.entries[0].detail)).not.toContain("dinner");

  // §7.5's "never emailed": nothing the app has sent carries the question. Every message this server wrote
  // is in one directory (design §5.1), including the summary notices the `sour.run` job queued above.
  expect(mailbox()).not.toContain(QUESTION);
  expect(mailbox()).not.toContain("late dinner");
});

test("the log belongs to the visit: a second clinician reads what the first asked, and a visit with none shows none", async ({ page }) => {
  const demo = await signInAsDemo(page);

  // The seeded visit (scripts/seed.ts) carries one answered follow-up, which is the shape no server here can
  // produce: a question with the answer beside it, read back by whoever opens the visit next.
  const visits = (await (await page.request.get("/api/provider")).json()) as { visits: { id: string; name: string }[] };
  const sam = visits.visits.find((v) => v.name === "Sam Sample");
  expect(sam, "the seeded demo patient should be on the dashboard").toBeTruthy();

  await page.goto(`/provider/${demo.id}?visit=${sam!.id}`);
  await expect(page.locator(".sour-brief-header")).toContainText("Sam Sample", LOADED);
  const seeded = page.locator(".sour-followup").first();
  await expect(seeded).toContainText("What is driving the overnight highs?", LOADED);
  await expect(seeded).toContainText("Dr. Demo Endo");
  await expect(seeded.locator(".sour-answer-reply")).toContainText(/dinner out/i);
  await expect(seeded.locator(".sour-answer-unanswered")).toHaveCount(0);
  await shot(page, "provider-sour-followup-answered", WHOLE_PAGE);

  // A visit nobody has asked about reads back an empty log, not the last visit's.
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Followup Empty", providerId: demo.id, visitType: "annual", channel: "none" })
  ).json()) as { visitId: string };
  const empty = (await (await page.request.get(`/api/sour?visitId=${booked.visitId}`)).json()) as { followUps: unknown[] };
  expect(empty.followUps).toEqual([]);

  // The guards on the route (§5.2): a visit id is required, and one that was never issued is a 404 — the
  // same answer another practice's visit gets (lib/guard.ts).
  expect((await page.request.get("/api/sour")).status()).toBe(400);
  expect((await page.request.get("/api/sour?visitId=not-a-visit")).status()).toBe(404);
});
