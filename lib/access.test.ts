import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, CAPABILITY_NAMES, DEFAULT_ROLE, ROLES, can, capabilitiesOf, isRole, roleDescription, roleLabel } from "./access";

// Design §5.2, cell by cell. The table is the only statement of who may do what in the app, so it is worth
// asserting in the words of the design rather than by reading it back from itself.

test("the roles are the three §5.2 names, and the default is the least of them", () => {
  assert.deepEqual([...ROLES], ["admin", "clinician", "staff"]);
  assert.equal(DEFAULT_ROLE, "staff");
  assert.equal(can(DEFAULT_ROLE, "summaries:read"), false);
});

test("admin manages users and practice settings", () => {
  assert.equal(can("admin", "users:manage"), true);
  assert.equal(can("admin", "practice:manage"), true);
  for (const role of ["clinician", "staff"] as const) {
    assert.equal(can(role, "users:manage"), false, `${role} must not manage users`);
    assert.equal(can(role, "practice:manage"), false, `${role} must not change practice settings`);
  }
});

test("clinician sees and reviews summaries; staff does not", () => {
  assert.equal(can("clinician", "summaries:read"), true);
  assert.equal(can("clinician", "summaries:generate"), true);
  assert.equal(can("staff", "summaries:read"), false);
  assert.equal(can("staff", "summaries:generate"), false);
});

test("staff creates visits and sends invites; clinician does not", () => {
  assert.equal(can("staff", "visits:create"), true);
  assert.equal(can("staff", "visits:invite"), true);
  assert.equal(can("clinician", "visits:create"), false);
  assert.equal(can("clinician", "visits:invite"), false);
});

test("everyone who works here sees the visit list, which is the floor for the dashboard", () => {
  for (const role of ROLES) assert.equal(can(role, "visits:read"), true, `${role} must see the practice's visits`);
});

test("admin can do everything either of the others can, so a one-person practice is not locked out", () => {
  // The one-doctor practice is the common case and its only user is its admin (lib/authAdapter.ts).
  for (const capability of CAPABILITY_NAMES) {
    const others = can("clinician", capability) || can("staff", capability);
    if (others) assert.equal(can("admin", capability), true, `admin must also hold ${capability}`);
  }
});

test("a role nobody defined holds nothing: the default is no, so a typo locks out rather than lets in", () => {
  for (const capability of CAPABILITY_NAMES) {
    for (const bogus of ["Admin", "ADMIN", "owner", "", " staff", "superuser"]) {
      assert.equal(can(bogus, capability), false, `${JSON.stringify(bogus)} must not hold ${capability}`);
    }
    assert.equal(can(null, capability), false);
    assert.equal(can(undefined, capability), false);
  }
});

test("isRole accepts exactly the three and nothing shaped like them", () => {
  for (const role of ROLES) assert.equal(isRole(role), true);
  for (const value of ["admin ", "Clinician", "nurse", 1, null, undefined, {}]) assert.equal(isRole(value), false);
});

test("every capability belongs to at least one role, and names only roles that exist", () => {
  for (const [capability, roles] of Object.entries(CAPABILITIES)) {
    assert.ok(roles.length > 0, `${capability} is held by nobody, so the route behind it is dead`);
    for (const role of roles) assert.ok(isRole(role), `${capability} names ${role}, which is not a role`);
  }
});

test("capabilitiesOf is the row of the table, in table order", () => {
  assert.deepEqual(capabilitiesOf("staff"), ["visits:read", "visits:create", "visits:invite"]);
  assert.deepEqual(capabilitiesOf("clinician"), ["visits:read", "summaries:read", "summaries:generate"]);
  assert.deepEqual(capabilitiesOf("admin"), CAPABILITY_NAMES);
  assert.deepEqual(capabilitiesOf("whatever"), []);
});

test("the labels and descriptions are safe to put on a screen, including for an unknown role", () => {
  assert.equal(roleLabel("admin"), "Admin");
  assert.equal(roleLabel("staff"), "Staff");
  // Shown as stored rather than hidden: an admin reading the users list should see the odd value, not a blank.
  assert.equal(roleLabel("superuser"), "superuser");
  assert.equal(roleLabel(null), "unknown");
  for (const role of ROLES) {
    const text = roleDescription(role);
    assert.ok(text.length > 20 && text.endsWith("."), `${role} needs a sentence an admin can choose by`);
  }
});
