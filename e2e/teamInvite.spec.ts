import { expect, test } from "@playwright/test";
import { freshEmail, signInAs, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { SCREENFUL, shot } from "./shot";
import { UNSENDABLE_PORT } from "../playwright.config";

// T131 (design §2.1, §5.1, §8.1): the practice settings invite card on a deployment that cannot mail
// anybody — no email backend and no DEV_MAIL_DIR, which is the state a fresh `.env` is in.
//
// Nothing else in the suite can see this. Every other server in playwright.config.ts names a mailbox, so
// `canSendOrMailbox()` is true on all of them and the card's honest branch had no screen to be looked at —
// which is how the hint came to promise "They get an email asking them to sign in with this address" over a
// result note that already said the opposite. The sixth server exists for this one branch.
//
// The admin signs in against the *main* server and then walks over, because nobody can sign in to this one:
// with no sender, `sendVerificationRequest` throws and /provider/signin answers `?error=` (lib/auth.ts,
// T113). That dead end is the ticket. The session comes along because a cookie is not scoped to a port and
// both builds are given the same AUTH_SECRET and the same database, so what is being looked at is this
// server rendering this practice's settings — the same thing an admin would see if its sender broke under
// them.
//
// A fresh address, not the seeded demo practice: §13.4 closes a demo practice's channels on its own
// (lib/demo.ts), and a card that is honest for two reasons at once proves neither of them.

const UNSENDABLE = `http://localhost:${UNSENDABLE_PORT}`;

/** Anything that reads as an email reaching the colleague, which is what the hint used to claim. Narrow on
 *  purpose, the way lib/teamInvite.test.ts states it: "did not go out" is a refusal with "go" in it, and
 *  "Work email" is the field's own label. */
const MOTION = /they get an email|comes to their own inbox|we(?:'| ha)ve (?:sent|emailed)|^Invited /im;

test("an office with no sender is told so before it invites anybody, and is not sent down the sign-in dead end", async ({ page }) => {
  // An address nobody has invited gets a practice of its own, as its admin (§2.1, lib/authAdapter.ts).
  const adminEmail = freshEmail("teresa.okonkwo", "unsendable-endo.com");
  await signInAs(page, adminEmail);

  await page.goto(`${UNSENDABLE}/provider/settings`);
  const card = page.locator(".settings-card", { hasText: "Invite someone" });
  await expect(card).toBeVisible(LOADED);

  // 1. The hint, decided by the deployment rather than by a literal, and read before the admin does
  //    anything. Staff's words: who to ask, and no variable, backend or credential (§3.7, §10.6).
  const hint = card.locator(".settings-invite-hint");
  await expect(hint).toHaveClass(/settings-invite-hint-blocked/);
  await expect(hint).toContainText("Sweet Spot cannot send email yet — ask whoever set it up for your office");
  await expect(hint).toContainText(/add someone and set their role/);
  await expect(hint).not.toContainText(/EMAIL_FROM|RESEND|DEV_MAIL_DIR|SES/);
  // 2. Nothing anywhere on the card claims a colleague will be emailed — the whole card, because the bug
  //    was one literal beside a branch and the next one would be too.
  expect(await card.innerText()).not.toMatch(MOTION);
  await shot(page, "provider-settings-invite-unsendable", { ...SCREENFUL, scrollTo: ".settings-invite-hint", block: "center" });

  // 3. And after an invite: the row is made, the role is set, and the note says the one thing that matters
  //    — nobody can sign in yet — instead of telling the admin to send them to a form that errors.
  const colleagueEmail = freshEmail("benjamin.vandermolen", "unsendable-endo.com");
  await card.getByLabel("Work email").fill(colleagueEmail);
  await card.getByRole("radio", { name: /Clinician/ }).check();
  await card.getByRole("button", { name: /Send invite/ }).click();

  const note = card.locator(".ss-error");
  await expect(note).toContainText(`${colleagueEmail} was added with that role`, LOADED);
  await expect(note).toContainText("they cannot sign in yet: Sweet Spot cannot send email yet");
  await expect(note).not.toContainText(/sign in with that address/i);
  expect(await card.innerText()).not.toMatch(MOTION);
  // The invite *is* the User row (lib/team.ts), so what the note says about the role is true of the table.
  await expect(page.locator(".settings-users tbody tr", { hasText: colleagueEmail })).toContainText(/Clinician/i);
  await shot(page, "provider-settings-invite-unsendable-sent", { ...SCREENFUL, scrollTo: ".settings-invite-hint", block: "center" });

  // 4. The dead end itself, which is the whole reason the note no longer points at it: the colleague goes
  //    to the sign-in form, types the address they were given, and is refused — `sendVerificationRequest`
  //    throws when nothing can send and Auth.js turns that into ?error= (lib/auth.ts, T113). This is the
  //    assertion that would have failed the old wording, not the wording of the new one.
  await signOutOfBrowser(page);
  await page.goto(`${UNSENDABLE}/provider/signin`);
  await page.getByLabel("Work email").fill(colleagueEmail);
  await page.getByRole("button", { name: /Email me a link/i }).click();
  await expect(page).toHaveURL(/\/provider\/signin\?error=/, LOADED);
  await expect(page.locator("body")).not.toContainText(/emailed you a link/i);
});

test("the same card on a deployment that can mail one is unchanged", async ({ page }) => {
  // The other half of the branch, on the main server, which has a mailbox: the sentence the ticket left
  // alone. Both cases in one spec so a reworded hint cannot pass by being honest on only one deployment.
  await signInAs(page, freshEmail("sendable.admin", "sendable-endo.com"));
  await page.goto("/provider/settings");
  const hint = page.locator(".settings-invite-hint");
  await expect(hint).toContainText("They get an email asking them to sign in with this address", LOADED);
  await expect(hint).toContainText("the one-time link comes to their own inbox");
  await expect(hint).not.toHaveClass(/settings-invite-hint-blocked/);
});
