// Unit tests for practices and the first person in one (T42, design §2.1, §4.1, §4.2, §5.2, §13.4).
//
// The claim worth pinning is the split between the two writers. `upsertProvider` is idempotent on email and
// renames the practice of whatever address it is handed, which is what `npm run seed` needs and exactly the
// cross-practice write §5.2 forbids a request from making; `signUpPractice` is the public path and is
// create-only, so POSTing a stranger's address cannot rename their practice or overwrite their name.
//
// lib/practice.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the module
// is pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it statically.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { HttpError } from "./httpError";
import { setLogSink } from "./log";

describe("lib/practice.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let practice: typeof import("./practice");
  let fx: FixtureSchema;

  before(async () => {
    fx = await fixtureSchema("practicetest", { useAsDefault: true });
    practice = await import("./practice");
    // signUpPractice logs practice_created; these tests assert on rows, not on stdout.
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    await fx?.drop();
  });

  beforeEach(async () => {
    await fx.db.user.deleteMany({});
    await fx.db.practice.deleteMany({});
  });

  describe("practiceNameFor", () => {
    it("titles the email domain, which reads better on the dashboard than the address", () => {
      assert.equal(practice.practiceNameFor("dr.ruiz@northside-endo.com"), "Northside Endo");
      assert.equal(practice.practiceNameFor("someone@mayo.org"), "Mayo");
    });

    it("falls back when there is no domain to read", () => {
      assert.equal(practice.practiceNameFor("nodomain"), "New practice");
      assert.equal(practice.practiceNameFor("trailing@"), "New practice");
      assert.equal(practice.practiceNameFor("@.com"), "New practice");
    });
  });

  describe("upsertProvider", () => {
    it("creates the practice and makes its first person the admin (§5.2)", async () => {
      const user = await practice.upsertProvider({ name: "Dr. First", email: "First@Fixture.Local", practice: "Fixture Endo" });
      assert.equal(user.email, "first@fixture.local", "the address is the key, so it is normalized");
      assert.equal(user.role, "admin");
      assert.equal(user.practice.name, "Fixture Endo");
      assert.equal(user.practice.isDemo, false);
    });

    it("names the practice after the person when no practice name is given", async () => {
      const user = await practice.upsertProvider({ name: "Dr. Solo", email: "solo@fixture.local" });
      assert.equal(user.practice.name, "Dr. Solo");
    });

    it("is idempotent on email, so re-running the seed makes one practice and not two", async () => {
      const first = await practice.upsertProvider({ name: "Dr. Demo Endo", email: "demo@fixture.local", practice: "Sweet Spot Endocrinology" });
      const again = await practice.upsertProvider({ name: "Dr. Demo Endo", email: "demo@fixture.local", practice: "Sweet Spot Endocrinology" });
      assert.equal(again.id, first.id);
      assert.equal(again.practiceId, first.practiceId);
      assert.equal(await fx.db.practice.count(), 1);
    });

    it("renames the practice on a re-run that gives a new name, and leaves it alone on one that does not", async () => {
      const first = await practice.upsertProvider({ name: "Dr. Rename", email: "rename@fixture.local", practice: "Old Name" });
      await practice.upsertProvider({ name: "Dr. Rename", email: "rename@fixture.local", practice: "New Name" });
      assert.equal((await fx.db.practice.findUniqueOrThrow({ where: { id: first.practiceId } })).name, "New Name");
      await practice.upsertProvider({ name: "Dr. Renamed Person", email: "rename@fixture.local" });
      const after = await fx.db.practice.findUniqueOrThrow({ where: { id: first.practiceId } });
      assert.equal(after.name, "New Name", "no practice name given, so the practice keeps the one it has");
      assert.equal((await fx.db.user.findUniqueOrThrow({ where: { id: first.id } })).name, "Dr. Renamed Person");
    });

    it("writes isDemo on every re-run that mentions it, in both directions (§13.4)", async () => {
      // This is how a practice seeded before T32 gets the flag, and how one told it is not a demo loses it.
      const user = await practice.upsertProvider({ name: "Dr. Flag", email: "flag@fixture.local", practice: "Flag Endo" });
      assert.equal(user.practice.isDemo, false);
      await practice.upsertProvider({ name: "Dr. Flag", email: "flag@fixture.local", isDemo: true });
      assert.equal((await fx.db.practice.findUniqueOrThrow({ where: { id: user.practiceId } })).isDemo, true);
      await practice.upsertProvider({ name: "Dr. Flag", email: "flag@fixture.local", isDemo: false });
      assert.equal((await fx.db.practice.findUniqueOrThrow({ where: { id: user.practiceId } })).isDemo, false);
    });
  });

  describe("ensureDemoProvider", () => {
    it("is the seed's admin of a practice that says it is a demo, at an address nobody owns (§13.4)", async () => {
      const user = await practice.ensureDemoProvider();
      assert.equal(user.email, practice.DEMO_PROVIDER_EMAIL);
      assert.equal(user.practice.name, practice.DEMO_PRACTICE_NAME);
      assert.equal(user.practice.isDemo, true);
      assert.equal(user.role, "admin");
      // `.local` is not a delegated TLD, so the address can never reach a real inbox.
      assert.match(practice.DEMO_PROVIDER_EMAIL, /\.local$/);
      assert.equal((await practice.ensureDemoProvider()).id, user.id, "twice is once");
    });
  });

  describe("signUpPractice", () => {
    it("creates a brand-new practice with its first user as admin (§2.1)", async () => {
      const user = await practice.signUpPractice({ name: "  Dr.   Nueva ", email: " Nueva@Fixture.Local ", practice: "  Nueva  Endo " });
      assert.equal(user.name, "Dr. Nueva");
      assert.equal(user.email, "nueva@fixture.local");
      assert.equal(user.practice.name, "Nueva Endo");
      assert.equal(user.role, "admin");
      assert.equal(user.practice.isDemo, false, "the public path never creates a demo practice");
    });

    it("names the practice after the person when the form leaves it blank", async () => {
      const user = await practice.signUpPractice({ name: "Dr. Blank", email: "blank@fixture.local", practice: "   " });
      assert.equal(user.practice.name, "Dr. Blank");
    });

    /** The public path refuses with an HttpError whose `event` is the log line's name (lib/httpError.ts). */
    const refuses = async (body: Record<string, unknown>, status: number, event: string) => {
      await assert.rejects(practice.signUpPractice(body), (e: unknown) => {
        assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
        assert.equal(e.status, status);
        assert.equal(e.event, event);
        return true;
      });
    };

    it("refuses an address that is not one, and a missing name", async () => {
      await refuses({ name: "Dr. Who", email: "not-an-email" }, 400, "signup_email_invalid");
      await refuses({ name: "Dr. Who", email: 42 }, 400, "signup_email_invalid");
      await refuses({ name: "   ", email: "ok@fixture.local" }, 400, "signup_name_invalid");
      await refuses({ email: "ok@fixture.local" }, 400, "signup_name_invalid");
      assert.equal(await fx.db.practice.count(), 0, "nothing was created");
    });

    it("refuses an address that already belongs to a practice, rather than renaming it (§5.2)", async () => {
      const first = await practice.signUpPractice({ name: "Dr. Incumbent", email: "taken@fixture.local", practice: "Incumbent Endo" });
      await refuses({ name: "Attacker", email: "Taken@Fixture.Local", practice: "Owned" }, 409, "signup_email_taken");
      const row = await fx.db.user.findUniqueOrThrow({ where: { id: first.id }, include: { practice: true } });
      assert.equal(row.name, "Dr. Incumbent", "the incumbent's name is untouched");
      assert.equal(row.practice.name, "Incumbent Endo", "and so is their practice's");
      assert.equal(await fx.db.practice.count(), 1);
    });
  });
});
