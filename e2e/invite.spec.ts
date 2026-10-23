import { expect, test } from "@playwright/test";
import { cannotSendYet, NO_CONSENT_TO_MESSAGE } from "../lib/delivery";
import { postJson } from "./api";
import { signInAsDemo } from "./auth";
import { LOADED } from "./budget";
import { SCREENFUL, shot } from "./shot";

// T120 (design §2.3, §8.1): what the two "Send link" buttons promise, judged against what this deployment
// can actually send.
//
// `POST /api/invite` used to answer `queued: true` for every visit, so `queued` meant only that a row had
// gone into `Job`, and both screens in front of it read that as the message going out: the dashboard row's
// note said "Sending now" and the Sour page said "Sending the link to this patient now". Reload the
// dashboard and the same visit's MESSAGES cell said Sweet Spot cannot send email yet (T110) — one visit with
// two stories, which is the contradiction T111 removed from the booking wizard one screen over.
//
// Its own spec rather than an addition to e2e/visits.spec.ts (§2.2, the dashboard) or to the Sour page's,
// because the subject is neither screen: it is the one claim both of them make, and the point of the ticket
// is that they make it in the same words. Split across two files, the pair could drift apart silently.
//
// Every test here books its own visit. Pressing Send link writes that visit's delivery rows, and the seeded
// ones are what e2e/notifications.spec.ts asserts §8.3 on.
//
// T129 (§5.5) added the third caller of that route on the same row: **New link**, which posts to it with
// `regenerate: true`, reads the same answer and writes into the same note element, and went on saying
// "New link sent." for a ticket after Send link beside it had stopped. It is the worse of the two to get
// wrong — it is what staff reach for when the first invite did not arrive, which is already the case where
// nothing can send, and it kills the link the patient may still have in hand — so it is pinned here, beside
// the pair it has to agree with.

/** A name, number and address nothing else in the run will use: two Playwright projects share one database,
 *  and §2.2 matches an existing patient on phone or email. */
const unique = (prefix: string) => {
  const name = `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return {
    name,
    phone: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`,
    email: `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`,
  };
};

/**
 * The sentence this gate's deployment gets, from the module that owns it rather than copied into the test.
 *
 * "both" is the channel every visit below is booked on, and it is the line that names no channel — the true
 * one when neither of the two has a backend (lib/delivery.ts, asserted on in lib/delivery.test.ts). Taking
 * it from there means rewording it is one edit and not three, while the thing this spec is actually pinning
 * — that the screens say it at all, instead of promising a send — still fails if either screen drifts back.
 */
const NOTHING_CONFIGURED = cannotSendYet("both");

/**
 * Record what **Copy intake** hands over, which nothing else can see (T129).
 *
 * `copyIntakeLink` writes with `navigator.clipboard.writeText`, which needs a permission this project does
 * not grant, and falls back to a textarea it removes again — so neither path leaves a token anywhere a test
 * can read. Recording the call is how the row's claim that Copy intake gives them the *new* link is checked
 * against the token the row is really carrying by then. Install it before the first navigation.
 */
async function recordCopies(page: Parameters<typeof signInAsDemo>[0]) {
  await page.addInitScript(() => {
    // Re-run on every navigation, so nothing here may be a property that cannot be redefined.
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
  });
  return () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

/** One visit of the signed-in provider's, on both channels, with the consent §2.2 wants behind it. */
async function book(page: Parameters<typeof signInAsDemo>[0], providerId: string, prefix: string, channel = "both") {
  const who = unique(prefix);
  const res = await postJson(page.request, "/api/book", {
    ...who,
    providerId,
    visitType: "follow_up",
    reason: "highs after dinner",
    channel,
    consentMethod: "phone",
  });
  const booked = (await res.json()) as { visitId: string; link: string };
  expect(booked.visitId, `POST /api/book: ${res.status()}`).toBeTruthy();
  return { ...who, ...booked };
}

test("the dashboard's Send link says no invite went out, and where the link is instead", async ({ page }) => {
  const demo = await signInAsDemo(page);
  const visit = await book(page, demo.id, "Invite Row");

  await page.reload();
  const row = page.locator(".provider-table tbody tr", { hasText: visit.name });
  await expect(row).toContainText("Invited", LOADED);

  await row.getByRole("button", { name: /^Send link$/ }).click();

  // The note is the wizard's sentence one screen over, and §8.1's fallback is the row's own Copy intake:
  // the link does not fit in a note under four buttons, and the button that hands it over is a press away.
  const note = row.locator(".provider-row-note");
  await expect(note).toContainText(`No invite sent: ${NOTHING_CONFIGURED}`, LOADED);
  await expect(note, "the claim this ticket was filed for").not.toContainText(/Sending now/i);
  await expect(note, "§8.1's fallback has to be reachable from the sentence that refuses").toContainText("Copy intake");
  await expect(row.getByRole("button", { name: /Copy intake/ }), "and the control it names is on the row").toBeVisible();

  // The cell and not the row: the table is `min-width: 1120px` inside a horizontal scroller, so at 375px the
  // Actions column and this note are off to the right until the shot asks for them (T57, T81). `end` rather
  // than `center` because the note is the last thing in the last column — centring it spends a third of a
  // phone frame on the page behind the table, and the columns it costs are the ones that say which visit
  // this is.
  await shot(page, "provider-row-invite-not-sent", {
    ...SCREENFUL,
    scrollTo: note,
    block: "center",
    inline: "end",
  });
});

test("the dashboard's New link kills the old link without claiming the new one went anywhere", async ({ page }) => {
  const copies = await recordCopies(page);
  const demo = await signInAsDemo(page);
  const visit = await book(page, demo.id, "Invite Regenerate");

  await page.reload();
  const row = page.locator(".provider-table tbody tr", { hasText: visit.name });
  await expect(row).toContainText("Invited", LOADED);

  // The tooltip is static markup, so it is wrong before anyone presses anything — which is why it is read
  // here first. It cannot quote a `reason`; what it owes is wording true in both deployments.
  const newLink = row.getByRole("button", { name: /^New link$/ });
  await expect(newLink).toHaveAttribute("title", /^Replace this patient's link with a new one\./);
  await expect(newLink, "the tooltip promised the send too").not.toHaveAttribute("title", /send|sent/i);

  // The link the patient has in hand right now, so the one the note promises afterwards can be told from it.
  await row.getByRole("button", { name: /Copy intake/ }).click();
  await expect(row.locator(".provider-row-note")).toContainText("Intake link copied", LOADED);

  // §5.5 asks first, and Playwright dismisses a dialog nobody is listening for.
  page.once("dialog", (dialog) => dialog.accept());
  await newLink.click();

  const note = row.locator(".provider-row-note");
  await expect(note, "the half that is true either way, and first").toContainText("The old link no longer works", LOADED);
  await expect(note).toContainText(`No invite sent: ${NOTHING_CONFIGURED}`);
  await expect(note, "the claim this ticket was filed for").not.toContainText(/New link sent/i);
  await expect(note, "§8.1's fallback has to be reachable from the sentence that refuses").toContainText("Copy intake");

  await shot(page, "provider-row-new-link-not-sent", {
    ...SCREENFUL,
    scrollTo: note,
    block: "center",
    inline: "end",
  });

  // And the control the note names hands over the token that replaced the dead one, not the dead one.
  await row.getByRole("button", { name: /Copy intake/ }).click();
  await expect(note).toContainText("Intake link copied", LOADED);
  const [before, after] = await copies();
  expect(before, "the link the patient had").toContain("/s/");
  expect(after, "and the one Copy intake gives them now").toContain("/s/");
  expect(after, "the row was still carrying the token the route had just thrown away").not.toBe(before);
});

test("the Sour page's Send link says the same, and still hands the link over", async ({ page }) => {
  const demo = await signInAsDemo(page);
  const visit = await book(page, demo.id, "Invite Brief");

  // ?visit=<id> is the deep link the summary email uses, and it is what puts a visit with no summary yet in
  // the sidebar at all (app/provider/[id]/sour.tsx).
  await page.goto(`/provider/${demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText(visit.name, LOADED);

  await page.locator(".sour-brief-actions").getByRole("button", { name: /^Send link$/ }).click();

  const note = page.locator(".sour-invite-note");
  await expect(note).toContainText(`No invite sent: ${NOTHING_CONFIGURED}`, LOADED);
  await expect(note, "the claim this ticket was filed for").not.toContainText(/Sending the link/i);
  // This screen had §8.1's fallback before the claim in front of it was true, and keeps it.
  await expect(note, "the link this screen already shared").toContainText("/s/");

  await shot(page, "sour-invite-not-sent", { ...SCREENFUL, scrollTo: note, block: "center" });
});

// The other half of both sentences: an office whose deployment *can* send is still told the link is on its
// way. What stands in for such a deployment is the one thing stubbed here, for the reason T111 gives in
// e2e/visits.spec.ts: this gate configures no sender at all (§11.3), and a server that did would have every
// invite in the suite attempt a real SES or SNS send on a box with ambient AWS credentials — the outbound
// calls T94 and T110 took out of it.
//
// So the route runs for real and the job is really enqueued; only `queued` and `reason` are rewritten to
// what POST /api/invite answers where the senders resolve to a backend instead of a reason. That it does
// answer that is lib/notify.test.ts's to assert, on the senders themselves.
test("a deployment with a sender still tells staff the link is on its way, on both screens", async ({ page }) => {
  const demo = await signInAsDemo(page);
  const visit = await book(page, demo.id, "Invite Configured");

  await page.route("**/api/invite", async (route) => {
    const response = await route.fetch();
    const answer = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...answer, queued: true, reason: undefined } });
  });

  await page.reload();
  const row = page.locator(".provider-table tbody tr", { hasText: visit.name });
  await expect(row).toContainText("Invited", LOADED);
  await row.getByRole("button", { name: /^Send link$/ }).click();

  const note = row.locator(".provider-row-note");
  await expect(note).toContainText("Sending now", LOADED);
  await expect(note).not.toContainText(/No invite sent/i);
  // The MESSAGES cell in this frame still says Sweet Spot cannot send email yet, and that is the stub
  // talking, not the bug: the row beside it is reporting the environment this gate really runs in. Nothing
  // on a real deployment with a sender shows both.
  await shot(page, "provider-row-invite-sending", {
    ...SCREENFUL,
    scrollTo: note,
    block: "center",
    inline: "end",
  });

  // T129 The third button on the row reads the same stubbed answer, and an office that can send is still
  // told the new link went out: this ticket took a claim away from one deployment and not from both.
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: /^New link$/ }).click();
  await expect(note).toContainText("New link sent. The old one no longer works.", LOADED);
  await expect(note).not.toContainText(/No invite sent/i);
  await shot(page, "provider-row-new-link-sending", {
    ...SCREENFUL,
    scrollTo: note,
    block: "center",
    inline: "end",
  });

  await page.goto(`/provider/${demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText(visit.name, LOADED);
  await page.locator(".sour-brief-actions").getByRole("button", { name: /^Send link$/ }).click();
  const briefNote = page.locator(".sour-invite-note");
  await expect(briefNote).toContainText("Sending the link to this patient now", LOADED);
  await expect(briefNote).not.toContainText(/No invite sent/i);
});

// Two different statements, and the route has to keep them apart: a practice that told us not to contact this
// patient is not a deployment that cannot (§2.2 against §8.1). Only the second one is anybody's to fix, and
// nobody should be sent looking for a sender over the first. Asserted on the route, because it is the route
// that chooses — both screens print whichever `reason` they are handed.
test("a visit nobody consented to message reads differently from one nothing can send", async ({ page }) => {
  const demo = await signInAsDemo(page);
  const noConsent = await book(page, demo.id, "Invite No Consent", "none");
  const unsendable = await book(page, demo.id, "Invite Unsendable");

  const answerFor = async (visitId: string) => {
    const res = await postJson(page.request, "/api/invite", { visitId });
    expect(res.status(), "the job is accepted either way (§8.3 still needs its delivery rows)").toBe(202);
    return (await res.json()) as { queued: boolean; reason?: string; link: string; jobId: string };
  };

  const chose = await answerFor(noConsent.visitId);
  expect(chose.queued).toBe(false);
  expect(chose.reason).toBe(NO_CONSENT_TO_MESSAGE);

  const cannot = await answerFor(unsendable.visitId);
  expect(cannot.queued).toBe(false);
  expect(cannot.reason).toBe(NOTHING_CONFIGURED);

  expect(chose.reason, "one of these is the deployment's to fix and the other is not").not.toBe(cannot.reason);
  // §8.1's fallback is on the response in both cases, and so is the job the MESSAGES cell reads (§8.3).
  for (const answer of [chose, cannot]) {
    expect(answer.link).toContain("/s/");
    expect(answer.jobId).toBeTruthy();
  }
});
