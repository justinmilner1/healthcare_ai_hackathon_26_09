import { expect, test, type Page } from "@playwright/test";
import { patchJson, postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";

// Practice membership and roles end to end (design §2.1, §5.2): the two sentences of §5.2, tried against the
// running app rather than against lib/access.ts. Nothing here stubs a session — each identity signs in by its
// own magic link, the way a person would (§5.1, e2e/auth.ts).
//
// Every state-changing call goes through postJson/patchJson (e2e/api.ts): middleware refuses a POST or PATCH
// that does not echo the CSRF cookie in a header (§10.8), and a 403 from middleware would pass for the 403 a
// role check gives, which is exactly the thing being asserted. The GETs need no header.
//
// The two things this is here to prove:
//   1. "a user never sees another practice's data" — and sees a 404, not a 403, so the refusal does not tell
//      them the visit exists.
//   2. the role a colleague was invited with is what they can do, in the API and on the screen.

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

const LOADED = { timeout: 30_000 };

test("a user from another practice gets 404 on this practice's visits", async ({ page }) => {
  // Practice A: the seeded one, with Sam Sample's visit in it (`npm run seed`).
  const demo = await signInAsDemo(page);
  const theirs = (await (await page.request.get("/api/provider")).json()) as { practiceId: string; visits: { id: string; name: string; token: string }[] };
  const visit = theirs.visits.find((v) => v.name === "Sam Sample");
  expect(visit, "npm run seed creates Sam Sample's visit").toBeTruthy();

  // Practice B: an address nobody has invited signs in and gets a practice of its own, as its admin (§2.1).
  await signOutOfBrowser(page);
  const stranger = await signInAs(page, freshEmail("stranger", "elsewhere-endo.com"));
  expect(stranger.practiceId).not.toBe(demo.practiceId);
  expect(stranger.role).toBe("admin");

  // Admin of their own practice, and that buys them nothing here. Not 403: a 403 would confirm the visit
  // exists, which is itself practice A's data (lib/guard.ts).
  for (const [what, status] of [
    ["GET /api/patient", (await page.request.get(`/api/patient/${visit!.id}`)).status()],
    ["POST /api/sour", (await postJson(page.request, "/api/sour", { visitId: visit!.id })).status()],
    ["POST /api/sour question", (await postJson(page.request, "/api/sour", { visitId: visit!.id, question: "why?" })).status()],
    // T16 (§7.3): signing off another practice's summary is the same 404 as not being able to read it.
    ["POST /api/review", (await postJson(page.request, "/api/review", { visitId: visit!.id })).status()],
    ["POST /api/invite", (await postJson(page.request, "/api/invite", { visitId: visit!.id })).status()],
  ] as const) {
    expect(status, `${what} on another practice's visit`).toBe(404);
  }

  // The list is the practice's own, so Sam is not in it and neither is anyone else.
  const mine = await (await page.request.get("/api/provider")).json();
  expect(mine.visits).toHaveLength(0);

  // The patient's link is not a practice's to hold either — but since T08 it is not a credential on its own
  // (§2.3, §5.3): it names the visit and a verified session opens it. So a stranger holding the token is
  // turned away for not having verified, not for being in the wrong practice, and the refusal says nothing
  // about whose visit it is.
  const forwarded = await page.request.get(`/api/patient/${visit!.token}`);
  expect(forwarded.status()).toBe(401);
  expect((await forwarded.json()).error).toMatch(/verify your link/i);
});

test("an admin invites a colleague, sets the practice up, and the invited role is what that colleague can do", async ({ page }) => {
  const adminEmail = freshEmail("admin", "northstar-roles.com");
  const staffEmail = freshEmail("nurse", "northstar-roles.com");
  await signInAs(page, adminEmail);

  // The dashboard offers settings to an admin; the link is what gets us there.
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible(LOADED);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/provider\/settings/);
  await expect(page.getByRole("heading", { name: "Users and roles." })).toBeVisible(LOADED);

  // Practice name and the retention window §10.4's sweep reads (§4.1).
  await page.getByLabel("Practice name").fill("Northstar Roles");
  await page.getByLabel("Keep patient data for").fill("90");
  await page.getByRole("button", { name: "Save practice" }).click();
  await expect(page.getByText("Saved.")).toBeVisible(LOADED);

  // Invite a receptionist. Staff is the default role, so this is the form as it stands.
  await page.getByLabel("Work email").fill(staffEmail);
  await page.getByRole("button", { name: /Send invite/i }).click();
  await expect(page.getByText(new RegExp(`Invited ${staffEmail.replace("+", "\\+")}`))).toBeVisible(LOADED);
  await expect(page.locator(".provider-table")).toContainText(staffEmail);
  await expect(page.locator(".provider-table")).toContainText("Invited");
  await shot(page, "provider-settings");

  // A retention window outside the bounds never leaves the browser — the input carries min and max, so the
  // form does not submit — which is why the server's own refusal is checked where it can be reached. §10.4's
  // sweep reads this number, so "keep nothing" has to be refused by the route and not only by the screen.
  for (const retentionDays of [3, 99999, 90.5, "ninety"]) {
    const refused = await patchJson(page.request, "/api/practice", { retentionDays });
    expect(refused.status(), `retentionDays=${retentionDays}`).toBe(400);
    expect((await refused.json()).error).toMatch(/between 30 and 3650/);
  }
  // And the name cannot be blanked by a rename.
  expect((await patchJson(page.request, "/api/practice", { name: "   " })).status()).toBe(400);
  expect((await (await page.request.get("/api/practice")).json()).practice).toMatchObject({ name: "Northstar Roles", retentionDays: 90 });

  // The admin books a visit, so the practice has one for the colleague to find.
  const booked = await (
    await postJson(page.request, "/api/book", { name: "Roles Patient", visitType: "follow_up", channel: "none" })
  ).json();
  expect(booked.visitId).toBeTruthy();

  // Now as the colleague. They were invited, so the link lands them in this practice rather than a new one.
  await signOutOfBrowser(page);
  const staff = await signInAs(page, staffEmail);
  expect(staff.role).toBe("staff");
  expect(staff.practice).toBe("Northstar Roles");

  // Staff books visits and sends invites (§5.2) …
  expect(staff.id).toBeTruthy();
  const theirs = (await (await page.request.get("/api/provider")).json()) as { visits: { id: string }[] };
  expect(theirs.visits.map((v) => v.id)).toContain(booked.visitId);
  expect((await postJson(page.request, "/api/invite", { visitId: booked.visitId })).status()).toBe(202);
  expect((await postJson(page.request, "/api/book", { name: "Booked By Staff", channel: "none" })).ok()).toBeTruthy();

  // … and does not read summaries or manage the practice. Their own practice's visit, and still 403: this is
  // the role saying no, which is a different answer from the 404 above and says so.
  for (const [what, status] of [
    ["GET /api/patient", (await page.request.get(`/api/patient/${booked.visitId}`)).status()],
    ["POST /api/sour", (await postJson(page.request, "/api/sour", { visitId: booked.visitId })).status()],
    // T16 (§7.3): a sign-off is a clinical attestation, so `summaries:review` is not staff's either.
    ["POST /api/review", (await postJson(page.request, "/api/review", { visitId: booked.visitId })).status()],
    ["GET /api/practice", (await page.request.get("/api/practice")).status()],
    ["POST /api/practice/users", (await postJson(page.request, "/api/practice/users", { email: "someone@northstar-roles.com" })).status()],
    // The audit log is the admin's (§10.2, T12), like the practice settings beside it.
    ["GET /api/audit", (await page.request.get("/api/audit")).status()],
  ] as const) {
    expect(status, `${what} as staff`).toBe(403);
  }

  // The screen agrees with the routes: no settings link, no Sour buttons, and /provider/settings sends them back.
  await page.goto("/provider");
  await expect(page.locator(".provider-table")).toContainText("Roles Patient", LOADED);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open in Sour|Summarize/ })).toHaveCount(0);
  await shot(page, "provider-dashboard-staff");

  await page.goto("/provider/settings");
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/);
  await expect(page).not.toHaveURL(/settings/);

  // Same for the audit trail: the screen is a door, not the lock, and it is shut for staff too (T12, §10.2).
  await expect(page.getByRole("link", { name: "Audit" })).toHaveCount(0);
  await page.goto("/provider/audit");
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/);
  await expect(page).not.toHaveURL(/audit/);
});

test("a practice cannot be left without an admin", async ({ page }) => {
  const adminEmail = freshEmail("solo", "only-admin.com");
  const me = await signInAs(page, adminEmail);

  // The only admin, demoting themselves: refused, or nobody could ever invite or rename again.
  const refused = await patchJson(page.request, `/api/practice/users/${me.id}`, { role: "clinician" });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toMatch(/only admin/i);

  // With a second admin it goes through, and the demoted one loses the settings page with it.
  const second = freshEmail("deputy", "only-admin.com");
  const invited = await (await postJson(page.request, "/api/practice/users", { email: second, role: "admin" })).json();
  expect(invited.member.role).toBe("admin");
  expect((await patchJson(page.request, `/api/practice/users/${me.id}`, { role: "clinician" })).ok()).toBeTruthy();
  expect((await page.request.get("/api/practice")).status()).toBe(403);

  // A clinician reads summaries, which is the half of §5.2 staff does not have.
  const booked = await (await postJson(page.request, "/api/book", { name: "Clinician Patient", channel: "none" })).json();
  expect(booked.error, "a clinician does not book visits").toMatch(/cannot do this/i);
});

test("the provider routes refuse a caller with no session", async ({ request }) => {
  // No session cookie, but a valid CSRF token: postJson primes one off /api/health/live (e2e/api.ts). That
  // is the point — without it middleware answers 403 before the route is reached, and a 403 is also what a
  // wrong role gets, so the refusal being asserted here would be the §10.8 one rather than the §5.2 one.
  // /api/book used to fall back to the seeded demo provider, so it was a 200: anyone on the internet could
  // create patients in someone else's practice.
  expect((await postJson(request, "/api/book", { name: "Nobody At All", channel: "none" })).status()).toBe(401);
  expect((await request.get("/api/provider")).status()).toBe(401);
  expect((await request.get("/api/practice")).status()).toBe(401);
  expect((await postJson(request, "/api/invite", { visitId: "whatever" })).status()).toBe(401);
  expect((await postJson(request, "/api/sour", { visitId: "whatever" })).status()).toBe(401);
  expect((await request.get("/api/audit")).status()).toBe(401);
});
