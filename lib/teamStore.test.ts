// Unit tests for the team writers (T42, design §2.1, §4.1, §4.2, §5.2, §13.4).
//
// lib/team.ts holds the validators and lib/team.test.ts covers them; this is the database half, and the
// claims here are the ones only rows can settle. An invite is the User row, so the second invite for an
// address that is already somewhere has to be a 409 rather than a quiet overwrite of their role — changing a
// role is a separate, visible act. And a practice always keeps one admin, or nobody can invite, rename or set
// retention again, so the last one cannot be demoted, including by themselves.
//
// lib/teamStore.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the module
// is pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it statically.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { HttpError } from "./httpError";
import { setLogSink } from "./log";
import { MAX_PERSON_NAME, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "./team";

describe("lib/teamStore.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let fx: FixtureSchema;
  let store: typeof import("./teamStore");
  let mailDir = "";
  const saved = { dir: process.env.DEV_MAIL_DIR };
  const ids = { practice: "", admin: "", other: "" };
  let admin: { id: string; name: string | null; email: string };

  before(async () => {
    // The invite email goes to the local mailbox rather than to a backend, so the suite neither needs nor
    // depends on one wherever it runs (lib/devMailbox.ts, docs/ROUTINES.md).
    mailDir = mkdtempSync(join(tmpdir(), "teamstore-mail-"));
    process.env.DEV_MAIL_DIR = mailDir;
    fx = await fixtureSchema("teamstoretest", { useAsDefault: true });
    store = await import("./teamStore");
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    if (saved.dir === undefined) delete process.env.DEV_MAIL_DIR;
    else process.env.DEV_MAIL_DIR = saved.dir;
    rmSync(mailDir, { recursive: true, force: true });
    await fx?.drop();
  });

  beforeEach(async () => {
    await fx.db.user.deleteMany({});
    await fx.db.practice.deleteMany({});
    const practice = await fx.db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const first = await fx.db.user.create({ data: { practiceId: practice.id, email: "admin@fixture.local", name: "Dr. Admin", role: "admin", emailVerified: new Date() } });
    const elsewhere = await fx.db.practice.create({ data: { name: "Somewhere Else" } });
    const them = await fx.db.user.create({ data: { practiceId: elsewhere.id, email: "them@elsewhere.local", role: "admin" } });
    ids.practice = practice.id;
    ids.admin = first.id;
    ids.other = them.id;
    admin = { id: first.id, name: first.name, email: first.email };
  });

  const refusal = async (p: Promise<unknown>, status: number, event: string) => {
    let thrown: unknown;
    await assert.rejects(p, (e: unknown) => ((thrown = e), true));
    assert.ok(thrown instanceof HttpError, `expected an HttpError, got ${String(thrown)}`);
    assert.equal(thrown.status, status);
    assert.equal(thrown.event, event);
    return thrown;
  };

  describe("practiceTeam", () => {
    it("is the practice and who works in it, admins first then oldest first", async () => {
      await fx.db.user.create({ data: { practiceId: ids.practice, email: "zoe@fixture.local", name: "Zoe", role: "staff" } });
      await fx.db.user.create({ data: { practiceId: ids.practice, email: "cleo@fixture.local", name: "Cleo", role: "clinician" } });
      const team = await store.practiceTeam(ids.practice);
      assert.deepEqual(team.practice, { id: ids.practice, name: "Fixture Endocrinology", retentionDays: 365, isDemo: false });
      assert.deepEqual(team.users.map((u) => u.role), ["admin", "clinician", "staff"]);
    });

    it("marks an invite nobody has redeemed as pending", async () => {
      await fx.db.user.create({ data: { practiceId: ids.practice, email: "invited@fixture.local", role: "staff" } });
      const byEmail = Object.fromEntries((await store.practiceTeam(ids.practice)).users.map((u) => [u.email, u.pending]));
      assert.equal(byEmail["invited@fixture.local"], true);
      assert.equal(byEmail["admin@fixture.local"], false, "this one has signed in");
    });

    it("keeps another practice's people out (§5.2)", async () => {
      const team = await store.practiceTeam(ids.practice);
      assert.deepEqual(team.users.map((u) => u.email), ["admin@fixture.local"]);
    });

    it("is a 404 for a practice that is not there", async () => {
      await refusal(store.practiceTeam("cl000000000000000000000000"), 404, "practice_not_found");
    });
  });

  describe("updatePracticeSettings", () => {
    it("renames the practice, sets the retention window, or both", async () => {
      assert.equal((await store.updatePracticeSettings(ids.practice, { name: "  Renamed  Endo " })).practice.name, "Renamed Endo");
      assert.equal((await store.updatePracticeSettings(ids.practice, { retentionDays: "90" })).practice.retentionDays, 90);
      const both = await store.updatePracticeSettings(ids.practice, { name: "Both Endo", retentionDays: 120 });
      assert.equal(both.practice.name, "Both Endo");
      assert.equal(both.practice.retentionDays, 120);
    });

    it("leaves an absent field alone", async () => {
      await store.updatePracticeSettings(ids.practice, { retentionDays: 90 });
      const after = await store.updatePracticeSettings(ids.practice, { name: "Only The Name" });
      assert.equal(after.practice.retentionDays, 90);
    });

    it("refuses a present field that does not survive its validator, rather than no-opping", async () => {
      await refusal(store.updatePracticeSettings(ids.practice, { name: "   " }), 400, "practice_name_invalid");
      for (const days of ["banana", 0, MIN_RETENTION_DAYS - 1, MAX_RETENTION_DAYS + 1, 90.5]) {
        await refusal(store.updatePracticeSettings(ids.practice, { retentionDays: days }), 400, "retention_days_invalid");
      }
      assert.equal((await store.practiceTeam(ids.practice)).practice.retentionDays, 365, "nothing was written");
    });

    it("refuses a patch with nothing in it", async () => {
      await refusal(store.updatePracticeSettings(ids.practice, {}), 400, "practice_patch_empty");
    });

    it("takes both ends of the range", async () => {
      assert.equal((await store.updatePracticeSettings(ids.practice, { retentionDays: MIN_RETENTION_DAYS })).practice.retentionDays, MIN_RETENTION_DAYS);
      assert.equal((await store.updatePracticeSettings(ids.practice, { retentionDays: MAX_RETENTION_DAYS })).practice.retentionDays, MAX_RETENTION_DAYS);
    });
  });

  describe("inviteMember", () => {
    it("creates the User row that is the invite, and sends the email (§2.1)", async () => {
      const result = await store.inviteMember({ practiceId: ids.practice, email: " New.Person@Fixture.Local ", name: "  New   Person ", role: "clinician", invitedBy: admin });
      assert.equal(result.member.email, "new.person@fixture.local");
      assert.equal(result.member.name, "New Person");
      assert.equal(result.member.role, "clinician");
      assert.equal(result.member.pending, true, "the row is the invite; it is pending until they sign in");
      assert.equal(result.sent, true);
      assert.equal(result.error, undefined);
      assert.equal(await fx.db.user.count({ where: { practiceId: ids.practice } }), 2);
    });

    it("defaults the role rather than guessing at one", async () => {
      const result = await store.inviteMember({ practiceId: ids.practice, email: "defaulted@fixture.local", invitedBy: admin });
      assert.equal(result.member.role, "staff");
    });

    it("refuses an address that is not one, and a role that is not one", async () => {
      await refusal(store.inviteMember({ practiceId: ids.practice, email: "nope", invitedBy: admin }), 400, "invite_email_invalid");
      await refusal(store.inviteMember({ practiceId: ids.practice, email: "ok@fixture.local", role: "owner", invitedBy: admin }), 400, "invite_role_invalid");
      assert.equal(await fx.db.user.count({ where: { practiceId: ids.practice } }), 1);
    });

    it("is a 409 for an address that is already here, and says which case it is", async () => {
      // Quietly re-sending would also quietly overwrite their role; that is setMemberRole's job.
      const here = await refusal(store.inviteMember({ practiceId: ids.practice, email: "Admin@Fixture.Local", role: "staff", invitedBy: admin }), 409, "invite_email_taken");
      assert.match(here.message, /already in this practice/);
      const elsewhere = await refusal(store.inviteMember({ practiceId: ids.practice, email: "them@elsewhere.local", invitedBy: admin }), 409, "invite_email_taken");
      assert.match(elsewhere.message, /another practice/);
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.admin } })).role, "admin", "the incumbent's role is untouched");
    });

    it("is a 404 for a practice that is not there, and creates nobody", async () => {
      await refusal(store.inviteMember({ practiceId: "cl000000000000000000000000", email: "nowhere@fixture.local", invitedBy: admin }), 404, "practice_not_found");
      assert.equal(await fx.db.user.count({ where: { email: "nowhere@fixture.local" } }), 0);
    });

    it("makes the User row even when the invite email could not go anywhere (§13.4)", async () => {
      // A demo practice writes only to reserved addresses, so this send is blocked — and the row is the
      // invite, so a send that fails must cost nothing: the admin sees `sent: false`, not a half-made user.
      await fx.db.practice.update({ where: { id: ids.practice }, data: { isDemo: true } });
      const result = await store.inviteMember({ practiceId: ids.practice, email: "real.person@northside-endo.com", invitedBy: admin });
      assert.equal(result.sent, false);
      assert.ok(result.error, "the admin is told why");
      assert.equal(await fx.db.user.count({ where: { email: "real.person@northside-endo.com" } }), 1);
    });
  });

  // T115, design §4.2, §10.2. The only writer of `User.name` for a person who signed themselves up. The
  // invite form has an optional name field, but the admin who creates a practice never passes through it —
  // they create their own account — so before this the first user of every practice could not have a name.
  describe("setOwnName", () => {
    it("names the caller's own row, and writes §10.2's row for it", async () => {
      const named = await store.setOwnName({ practiceId: ids.practice, userId: ids.admin, name: "  Dr.   Jennifer   Rodriguez  " });
      // Collapsed and trimmed by cleanPersonName, like every other name this app stores (lib/team.ts).
      assert.equal(named.name, "Dr. Jennifer Rodriguez");
      assert.equal(named.pending, false, "naming yourself is not a sign-in and does not pretend to be one");
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.admin } })).name, "Dr. Jennifer Rodriguez");

      const rows = await fx.db.auditLog.findMany({ where: { practiceId: ids.practice } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, "user.name_set");
      assert.equal(rows[0].entityType, "user");
      assert.equal(rows[0].entityId, ids.admin);
      assert.equal(rows[0].actorId, ids.admin);
      // §4.8: `detail` is counts and constants. A colleague's name is neither, so it is not on the row.
      assert.equal((rows[0].detail ?? "").includes("Jennifer"), false);
      assert.match(rows[0].detail ?? "", /"role":"admin"/);
    });

    it("refuses a blank rather than quietly clearing the name", async () => {
      await store.setOwnName({ practiceId: ids.practice, userId: ids.admin, name: "Dr. Admin Two" });
      for (const blank of ["", "   ", null, 42]) {
        await refusal(store.setOwnName({ practiceId: ids.practice, userId: ids.admin, name: blank }), 400, "own_name_invalid");
      }
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.admin } })).name, "Dr. Admin Two", "nothing was written");
    });

    it("caps a name at the stored length", async () => {
      const named = await store.setOwnName({ practiceId: ids.practice, userId: ids.admin, name: "n".repeat(MAX_PERSON_NAME + 40) });
      assert.equal(named.name?.length, MAX_PERSON_NAME);
    });

    it("gives another practice's user the same 404 as one that never existed (§5.2)", async () => {
      // The id comes from the session, so a mismatch means the account moved practice under us; either way
      // this writer never reaches a row outside the practice it was given.
      await refusal(store.setOwnName({ practiceId: ids.practice, userId: ids.other, name: "Someone Else" }), 404, "user_not_in_practice");
      await refusal(store.setOwnName({ practiceId: ids.practice, userId: "cl000000000000000000000000", name: "Nobody" }), 404, "user_not_in_practice");
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.other } })).name, null, "nothing was written");
    });
  });

  describe("setMemberRole", () => {
    it("changes a colleague's role", async () => {
      const them = await fx.db.user.create({ data: { practiceId: ids.practice, email: "staffer@fixture.local", role: "staff" } });
      const updated = await store.setMemberRole({ practiceId: ids.practice, userId: them.id, role: "clinician", actorId: ids.admin });
      assert.equal(updated.role, "clinician");
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: them.id } })).role, "clinician");
    });

    it("says which role, or it is not a role change", async () => {
      const them = await fx.db.user.create({ data: { practiceId: ids.practice, email: "staffer@fixture.local", role: "staff" } });
      for (const role of [undefined, null, "", "owner", 3]) {
        await refusal(store.setMemberRole({ practiceId: ids.practice, userId: them.id, role, actorId: ids.admin }), 400, "role_invalid");
      }
    });

    it("is a no-op that still answers when the role is already that", async () => {
      const them = await fx.db.user.create({ data: { practiceId: ids.practice, email: "staffer@fixture.local", role: "staff" } });
      assert.equal((await store.setMemberRole({ practiceId: ids.practice, userId: them.id, role: "staff", actorId: ids.admin })).role, "staff");
    });

    it("gives another practice's user the same 404 as one that never existed (§5.2)", async () => {
      await refusal(store.setMemberRole({ practiceId: ids.practice, userId: ids.other, role: "staff", actorId: ids.admin }), 404, "user_not_in_practice");
      await refusal(store.setMemberRole({ practiceId: ids.practice, userId: "cl000000000000000000000000", role: "staff", actorId: ids.admin }), 404, "user_not_in_practice");
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.other } })).role, "admin", "nothing was written");
    });

    it("will not demote the last admin, including by themselves", async () => {
      // Otherwise nobody can invite, rename, or set retention again.
      const e = await refusal(store.setMemberRole({ practiceId: ids.practice, userId: ids.admin, role: "clinician", actorId: ids.admin }), 409, "last_admin");
      assert.match(e.message, /only admin/);
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: ids.admin } })).role, "admin");
    });

    it("demotes an admin once there is a second one", async () => {
      const second = await fx.db.user.create({ data: { practiceId: ids.practice, email: "second@fixture.local", role: "admin" } });
      assert.equal((await store.setMemberRole({ practiceId: ids.practice, userId: ids.admin, role: "staff", actorId: second.id })).role, "staff");
      await refusal(store.setMemberRole({ practiceId: ids.practice, userId: second.id, role: "staff", actorId: second.id }), 409, "last_admin");
    });

    it("counts admins per practice, not across the whole table", async () => {
      // Another practice's admin is not this practice's second one.
      assert.equal(await fx.db.user.count({ where: { role: "admin" } }), 2);
      await refusal(store.setMemberRole({ practiceId: ids.practice, userId: ids.admin, role: "staff", actorId: ids.admin }), 409, "last_admin");
    });
  });
});
