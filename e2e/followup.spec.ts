import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readDevMailFile } from "../lib/devMailbox";
import { detectSpikes, parseClarityCsv } from "../lib/glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "../lib/location";
import { matchSpikesToVisits } from "../lib/match";
import { SEED_FOLLOW_UP_QUESTION, seedFollowUpAnswer } from "../lib/seedFollowUp";
import { parseWhoopCsv } from "../lib/sleep";
import { csrfToken, postJson } from "./api";
import { MAIL_DIR, signInAsDemo } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyByApi } from "./patient";
import { shot } from "./shot";

// T18 (design §2.6, §7.5): "Follow-up questions to Sour are logged with the clinician id and the answer,
// visible on the page, never emailed."
//
// The three claims, on the running app. The one thing this suite cannot show is an answer arriving: there is
// no model on any of the servers playwright.config.ts starts (that is the point of them), so a question
// asked here is one the gateway refuses. That turns out to be the more interesting half of §7.5 anyway —
// the question is written before the model is called, so an outage is exactly when a log that is only page
// state loses what a clinician asked. The seeded visit carries an answered follow-up (scripts/seed.ts) for
// the other shape, which the second test reads.
//
// Since T195 that same fact decides whether there is a composer to drive at all, so two of the three tests
// here are about the two states of `narrativeMissing` as much as about the log: with no model configured
// the offer is withdrawn and the question goes in through the route, and with a gateway merely down it
// stands and the last test presses it. The row and the audit row are the same either way, which is the
// point — withdrawing the control withdraws nothing §7.5 records.
//
// The uploads go through `request` and not `page.request`: the patient's credential is the token plus the
// verified session the six-digit code leaves behind (§5.3), and keeping them in separate contexts means the
// provider session stays signed in for the half of the test that is the clinician's.

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

/** What `npm run seed` wrote on the demo visit's one answered follow-up, recomputed from the same sample
 *  files it derived it from (lib/seedFollowUp.ts). The spike set is the brief's: matched to Timeline places
 *  and cut to five, as lib/bundle.ts hands it to the page.
 *
 *  Both this process and the `npm run seed` that wrote the row take their zone from the environment
 *  scripts/agent-check.sh runs them in (neither loads `.env`), so the local times in the two agree. */
function seededFollowUpAnswer(): string {
  const sample = (f: string) => readFileSync(join(process.cwd(), "data", f), "utf8");
  const visits = labelVisits(parseTimeline(sample("timeline_sample.json")), parseVisitsCsv(sample("visits.csv")));
  const spikes = matchSpikesToVisits(detectSpikes(parseClarityCsv(sample("dexcom_clarity_sample.csv"))), visits).slice(0, 5);
  return seedFollowUpAnswer(spikes, parseWhoopCsv(sample("whoop_sample.csv")));
}

const QUESTION = "Which of the overnight highs followed a late dinner out?";

/**
 * Every message the local mailer has "sent" (design §5.1, lib/mailer.ts), as one blob.
 *
 * This is the shared mailbox e2e/auth.ts claims sign-in links out of by renaming them, so a name this
 * listing just saw can be gone by the time it is read: readDevMailFile skips that file instead of taking the
 * spec down with an ENOENT over somebody else's mail (T65). Skipping is safe for what this is asked — the
 * assertion below is that the question appears in *no* message, and a message that was claimed mid-walk was
 * a sign-in link, not the follow-up email this spec is proving never gets sent.
 */
function mailbox(dir = MAIL_DIR): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt"));
  } catch {
    return ""; // a mailbox no server has written to yet is an empty one
  }
  return names.map((n) => readDevMailFile(join(dir, n)) ?? "").join("\n");
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

  // This server has no model configured, so since T195 the brief offers nothing to type into — the
  // assertions for that are below, once there is a logged question beside them. §7.5's claims are about
  // what the route records, so the question goes in the way the form used to send it: the same POST, with
  // the CSRF header the page's own `apiFetch` adds (§10.8).
  const asked = await postJson(page.request, "/api/sour", { visitId: booked.visitId, question: QUESTION });
  expect(asked.status(), `POST /api/sour: ${await asked.text()}`).toBe(503);
  expect(((await asked.json()) as { error?: string }).error).toMatch(/until the model is configured/i);

  // §7.5 on the screen: the question, the clinician who asked it, and when. There is no model here, so the
  // answer never arrives — and the question is on the record all the same, which is what writing it before
  // the call buys (lib/followUps.ts). It is a row and not a piece of page state, which is why reading it
  // back on a fresh load of the one-pager is the same assertion as reading it at all.
  await page.reload();
  const logged = page.locator(".sour-followup").first();
  await expect(logged).toContainText(QUESTION, LOADED);
  await expect(logged).toContainText("Dr. Demo Endo");
  await expect(logged).toContainText(/today at/i);
  await expect(logged.locator(".sour-answer-unanswered")).toContainText(/No answer recorded/i);

  // T195 (§7.5, §6.3, §2.6): the frame this ticket was filed about. It used to hold the "Assistant not
  // configured" caveat, a question Sour never answered, the route's refusal — and below all four the same
  // composer, placeholder and enabled Send, inviting the clinician to do it again. The offer is withdrawn
  // where it can never work, and one sentence in the register of the caveat stands in its place.
  const card = page.locator(".sour-ask-card");
  await expect(page.locator(".sour-degraded-note")).toContainText(/Assistant not configured/i);
  await expect(card.locator(".sour-ask-closed")).toContainText(/Assistant not configured/i, LOADED);
  await expect(card.locator("form")).toHaveCount(0);
  await expect(card.locator("input[aria-label='Message Sour']")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /send/i })).toHaveCount(0);
  // The heading over it stops inviting what the sentence under it refuses. The rule rather than the
  // literal, so a reword in lib/sourState.ts that puts an invitation back fails here (T195).
  expect(await card.locator(".sour-ask-heading small").textContent(), "the card's sub-line").not.toMatch(/^Ask about/);
  // Withdrawing the offer withdraws no history: §7.5 makes the log a record of what was asked and by whom,
  // and that row is still the subject of this card.
  await expect(card.locator(".sour-followup")).toHaveCount(1);
  // Anchored on the card, because the subject of this frame is now at the foot of the brief: the desktop
  // project shoots the whole document either way, so this only moves the 375px one, which without it held
  // the page header and none of what the assertions above are about (e2e/shot.ts, T195).
  await shot(page, "provider-sour-followup", { scrollTo: ".sour-ask-card" });

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

// T196 (design §2.6, §6.3, §7.5, §10.2): the window T195's signal could not see.
//
// `narrativeMissing` only exists once a summary has been saved, so before that it reads `undefined` — the
// same value a model-written narrative carries — and the withdrawal above branched on it. Meanwhile
// `visitNotStarted` stops being true on the patient's *first* answer, so `.sour-ask-card` is rendered from
// that moment. Between the two, an unconfigured deployment went back to offering a placeholder and an
// enabled Send, and pressing it put a question on the visit's follow-up log and an audit row beside it
// before the model was asked and refused.
//
// **Why the generate call is intercepted.** That window closes by itself: first open with no summary
// auto-generates (app/provider/[id]/sour.tsx), and on this server the run saves a degraded pair whose
// `narrativeMissing` is `"unconfigured"` — which is exactly the state T195 already covers, so a test that
// let it run would be asserting T195 again and would pass with this ticket reverted. Aborting the page's own
// `POST /api/sour` holds the brief in the state the ticket was filed about, with no summary row for the card
// to read. The question path is a POST to the same route and is deliberately *not* what this stages: there
// is no composer here to press, which is the whole assertion.
test("the brief offers no composer mid-intake on a deployment with no model, before any summary exists", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Followup Midintake");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Followup Midintake", email, providerId: demo.id, visitType: "follow_up", reason: "overnight highs", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId).toBeTruthy();

  // The patient's half, in its own context (§5.3): verified, then *one* of the follow-up template's two
  // required fields answered. One, not both — the second is the turn that wraps, and a wrap queues the
  // `sour.run` whose summary would take the brief out of this state (lib/sourQueue.ts `wrapQueuesSour`).
  // The GET first, because that is what writes the greeting and settles the field list (lib/sweetie.ts).
  await verifyByApi(request, booked.token, email);
  expect((await request.get(`/api/sweetie?token=${booked.token}`)).ok()).toBeTruthy();
  const turn = await postJson(request, "/api/sweetie", { token: booked.token, message: "My sugars run high after dinner, maybe four nights a week since I started the new job in August." });
  expect(turn.status(), await turn.text()).toBe(200);
  const after = (await turn.json()) as { intake: { wrapped?: boolean }; status: { answered: number } };
  expect(after.intake.wrapped, "one answer of two does not wrap").toBe(false);
  expect(after.status.answered, "the visit has started, so the card below is rendered").toBeGreaterThan(0);

  // Hold the window open: the page's own first-open generate is the thing that closes it (see above). Only
  // that call — it is the one with no `question` in its body — so nothing else on the route is staged.
  await page.route("**/api/sour", async (route) => {
    const body = route.request().postData() ?? "";
    if (route.request().method() === "POST" && !body.includes("question")) return route.abort();
    return route.continue();
  });

  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Followup Midintake", LOADED);
  // The state the ticket names, asserted rather than assumed: nothing has been summarized for this visit,
  // so `narrativeMissing` is `undefined` and the caveat at the top of the brief is not there either. A
  // composer withdrawn here is withdrawn on the deployment's own state and on nothing the summary said.
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "none", LOADED);
  await expect(page.locator(".sour-degraded-note"), "no saved summary, so nothing for narrativeNote to explain").toHaveCount(0);
  // And the card is rendered: this is not the `visitNotStarted` empty state, which has no composer to begin
  // with — the assertions below would pass vacuously on it.
  const card = page.locator(".sour-ask-card");
  await expect(card).toHaveCount(1);
  await expect(page.locator(".sour-waiting"), "EmptyIntake's card (app/provider/[id]/sour.tsx)").toHaveCount(0);

  // The fix (§7.5, §6.3): one sentence in place of the control, in the register of the saved-summary half.
  await expect(card.locator(".sour-ask-closed")).toContainText(/Assistant not configured/i, LOADED);
  await expect(card.locator("form")).toHaveCount(0);
  await expect(card.locator("input[aria-label='Message Sour']")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /send/i })).toHaveCount(0);
  // The heading follows the body, as it does on the saved-summary half: the rule and not the literal.
  expect(await card.locator(".sour-ask-heading small").textContent(), "the card's sub-line").not.toMatch(/^Ask about/);
  // §7.5's promise about the log survives the withdrawal in this window too, over no rows at all.
  expect(await card.locator(".sour-ask-heading small").textContent()).toMatch(/kept with the visit and shown to this practice/);
  await expect(card.locator(".sour-followup")).toHaveCount(0);

  // Nothing was asked, so nothing is on the record — the harm this ticket is about is the row a press left
  // behind (§7.5, §10.2), and the assertion that the control is gone is worth little without it.
  const log = (await (await page.request.get(`/api/sour?visitId=${booked.visitId}`)).json()) as { followUps: unknown[] };
  expect(log.followUps).toEqual([]);

  await shot(page, "provider-sour-midintake-no-model", { scrollTo: ".sour-ask-card" });
  await page.unroute("**/api/sour");
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
  await expect(seeded).toContainText(SEED_FOLLOW_UP_QUESTION, LOADED);
  await expect(seeded).toContainText("Dr. Demo Endo");
  // The seeded answer is derived from the same two sample exports the cards above it are drawn from
  // (lib/seedFollowUp.ts, T112), so this asserts the pair rather than a phrase: whatever the week's spikes
  // and nights make the sentence, the panel is showing that sentence and not a stale one in the database.
  await expect(seeded.locator(".sour-answer-reply")).toContainText(seededFollowUpAnswer());
  await expect(seeded.locator(".sour-answer-unanswered")).toHaveCount(0);
  // T195, §7.5: an answered question outlives the offer. This server has no model configured, so the
  // composer below the log is withdrawn — and the record above it, which is what the practice reads, is
  // untouched by that.
  await expect(page.locator(".sour-ask-card .sour-ask-closed")).toContainText(/Assistant not configured/i);
  await expect(page.locator(".sour-ask-card form")).toHaveCount(0);
  // Anchored on the log, because the phone project shoots one screenful and this panel is at the foot of the
  // brief: unanchored, the 375px frame of a shot named "followup-answered" held the page header and no
  // answer at all. The desktop shoots the document either way, so the anchor changes only the phone's frame
  // (e2e/shot.ts).
  await shot(page, "provider-sour-followup-answered", { scrollTo: ".sour-answers" });

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

// T195 (design §7.5, §6.3): the other half of `narrativeMissing`, and the half that keeps its composer.
//
// `lib/sourState.ts` is explicit that the two values are not alike: `"unavailable"` is a gateway that
// clears on its own, so a retry is worth offering (T63), while `"unconfigured"` does not clear from inside
// the product at all. The test above is the second; this is the first, and with it the live composer, the
// row arriving without a reload and the error beside it — the path the test above used to drive before the
// control was withdrawn from it.
//
// The state is reached by patching the bundle on its way to the page rather than by pointing the test at
// the gateway-down server on port+1. Every server here drains one shared queue (lib/jobs.ts: `drainJobs`
// claims any due row, whoever queued it), so which of them runs a `sour.run` — and therefore whether the
// saved summary reads "unavailable" or "unconfigured" — is a race this assertion must not depend on. What
// is being asserted is the page's branch on that one field, and the patch is the one way to put the field
// in exactly one state. A regex and not a glob, for the reason e2e/flows.spec.ts gives: `**` around a path
// segment is the pattern that silently matches nothing and leaves a test passing for the wrong reason —
// and the caveat asserted first is the proof that this one did match.
test("a gateway that is merely down keeps the composer: the retry is worth offering, and the question still lands", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Followup Down");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Followup Down", email, providerId: demo.id, visitType: "follow_up", reason: "overnight highs", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId).toBeTruthy();

  await verifyByApi(request, booked.token, email);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(uploaded.ok(), `POST /api/upload: ${uploaded.status()}`).toBeTruthy();

  // Two fields, not one (T196). The state being staged is a deployment that *has* a model whose gateway is
  // failing, and since T196 the bundle says that in two places: `narrativeMissing` is what the last run
  // recorded, and `assistantConfigured` is whether a model exists at all. Patching only the first on this
  // suite's unconfigured server fabricated a bundle the product cannot produce — "the gateway failed", which
  // only a configured deployment can record, beside "there is no model" — and the composer closed on the
  // second field, correctly, in a test whose whole subject is that it stays open. So the patch sets both,
  // and the fixture is now one coherent deployment rather than half of two.
  await page.route(/\/api\/patient\//, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { providerSummary?: { narrativeMissing?: string } | null; assistantConfigured?: boolean };
    if (body?.providerSummary) body.providerSummary.narrativeMissing = "unavailable";
    body.assistantConfigured = true;
    await route.fulfill({ response: res, json: body });
  });

  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Followup Down", LOADED);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", LOADED);
  // The patch reached the page: this is the gateway sentence, not the unconfigured one. Without it every
  // assertion below would be about the state the test above already covers.
  await expect(page.locator(".sour-degraded-note")).toContainText(/gateway unavailable/i, LOADED);

  // The offer stands, whole: somewhere to type, something to press, and no sentence saying there is not.
  const card = page.locator(".sour-ask-card");
  await expect(card.locator(".sour-ask-closed")).toHaveCount(0);
  const input = card.locator("input[aria-label='Message Sour']");
  await expect(input).toBeEnabled();
  // T153's rule, on the one live composer left in the suite: this visit shared Dexcom and no WHOOP, so the
  // box offers the readings and does not offer sleep data beside a Sleep tile that has none
  // (lib/sourState.ts `askSourPlaceholder`, whose four combinations lib/sourState.test.ts pins).
  await expect(input).toHaveAttribute("placeholder", /glucose spikes/i);
  await expect(input).not.toHaveAttribute("placeholder", /sleep/i);
  expect(await card.locator(".sour-ask-heading small").textContent(), "the card's sub-line").toMatch(/^Ask about/);
  // Taken here and not at the end of the test: what this frame is evidence of is the offer standing beside
  // a caveat that says the gateway is down, and pressing Send first would put the other state's refusal in
  // it. The server behind the patched bundle is the suite's unconfigured one, so the words that come back
  // are that server's, and a frame holding both sentences at once would be a picture of the fixture rather
  // than of either state (T195).
  await shot(page, "provider-sour-followup-gateway-down", { scrollTo: ".sour-ask-card" });

  // And it is a control and not a picture of one. What this half asserts is the page's share of §7.5, which
  // is the same whichever refusal comes back: the row appears without a reload, carrying the question and
  // the clinician who asked it, and the error is in front of whoever pressed Send. The refusal's own
  // wording is read where the route is the subject, which is the first test in this file.
  await input.fill(QUESTION);
  await card.locator("form button").click();
  const logged = card.locator(".sour-followup").first();
  await expect(logged).toContainText(QUESTION, LOADED);
  await expect(logged).toContainText("Dr. Demo Endo");
  await expect(logged.locator(".sour-answer-unanswered")).toContainText(/No answer recorded/i);
  await expect(card.locator(".ss-error")).toContainText(/Sour chat is unavailable/i);
});
