import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
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

test("the audit log is readable by practice admins and nobody else (§10.2)", () => {
  assert.equal(can("admin", "audit:read"), true);
  for (const role of ["clinician", "staff"] as const) {
    assert.equal(can(role, "audit:read"), false, `${role} must not read the practice's audit log`);
  }
});

test("clinician sees and reviews summaries; staff does not", () => {
  assert.equal(can("clinician", "summaries:read"), true);
  assert.equal(can("clinician", "summaries:generate"), true);
  // §7.3's sign-off is the "reviews" half of that sentence, and is a clinical attestation: the two roles
  // §5.2 gives summaries to, and nobody else.
  assert.equal(can("clinician", "summaries:review"), true);
  assert.equal(can("admin", "summaries:review"), true);
  assert.equal(can("staff", "summaries:read"), false);
  assert.equal(can("staff", "summaries:generate"), false);
  assert.equal(can("staff", "summaries:review"), false);
});

test("staff creates visits and sends invites; clinician does not", () => {
  assert.equal(can("staff", "visits:create"), true);
  assert.equal(can("staff", "visits:invite"), true);
  assert.equal(can("clinician", "visits:create"), false);
  assert.equal(can("clinician", "visits:invite"), false);
});

test("deleting a patient's data is a staff action, and not a clinician's (§10.5)", () => {
  // §10.5 calls it "a staff action" and §2.8 has the request arriving through the practice, which is the
  // front desk. Admin holds it too, or a one-person practice could not honour a deletion request at all.
  assert.equal(can("staff", "patients:delete"), true);
  assert.equal(can("admin", "patients:delete"), true);
  assert.equal(can("clinician", "patients:delete"), false, "reading a summary is not a reason to destroy it");
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
  assert.deepEqual(capabilitiesOf("staff"), ["visits:read", "visits:create", "visits:invite", "patients:delete"]);
  assert.deepEqual(capabilitiesOf("clinician"), ["visits:read", "summaries:read", "summaries:generate", "summaries:review"]);
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

// ---------------------------------------------------------------------------------------------
// The enforcement half of §5.2: "*Every* API route checks practice membership and role." A table nobody
// consults is not an access rule, and the way that goes wrong is a route added later with no guard on it —
// which no test of lib/access.ts would ever notice. So the routes are read from disk, like lib/log.test.ts
// reads them for withRoute, and every one is either guarded or listed below with the credential it uses
// instead. Adding a route means adding a guard or a line here, on purpose.

/** Routes that answer without a provider session, and what they check instead of a role. */
const NOT_PROVIDER_ROUTES: Record<string, string> = {
  "api/auth/[...nextauth]": "Auth.js itself: this is where a session comes from (§5.1)",
  "api/health": "the dependency report for the deploy gate; says nothing about anyone (§11.2)",
  "api/health/live": "liveness for the load balancer; touches nothing and says nothing about anyone (§11.2)",
  "api/jobs/run": "the scheduler, on a shared secret in the Authorization header (§3.4)",
  "api/notifications/sns": "SNS, on its own RSA signature over the message plus a configured topic ARN (§8.1, lib/snsSignature.ts)",
  "api/verify": "the patient, on the invite token alone: this is the route that turns it into a session (§2.3, §5.3)",
  "api/consent": "the patient, on the invite token in the body plus the session it names; their own answer to the consent screen (§2.4)",
  "api/sweetie": "the patient, on the invite token in the body plus the session it names (§5.3)",
  "api/upload": "the patient, on the invite token in the form plus the session it names (§4.6, §5.3)",
  "api/dexcom/connect": "the patient, on the invite token plus the session it names (§9.1)",
  "api/dexcom/callback": "Dexcom's redirect, on the one-use state bound to an httpOnly cookie (§9.1)",
  "api/dexcom/status": "the patient, on the invite token plus the session it names (§9.1)",
  "api/dexcom/demo": "the patient, on the invite token plus the session it names; makes an isolated demo visit (§9.1)",
  demo: "a redirect to the sign-in form with an address filled in; signs nobody in",
};

/**
 * Routes a signed-in provider of any role may call, and why no capability narrows them. Each is about the
 * caller's **own** row rather than about the practice's data, so §5.2's "checks practice membership and
 * role" is satisfied by the session alone: there is no role for which the answer would be different, and
 * nothing another account owns is reachable through it. Listed rather than inferred, like the two above, so
 * a route with no capability on it is a decision somebody wrote down.
 */
const ANY_ROLE_ROUTES: Record<string, string> = {
  "api/practice/me": "the caller's own name on their own row (§4.2, T115): the session names the row, so there is nothing to scope",
};

/** `/api/patient/[id]` and `/api/provider` take both kinds of caller, so the file-wide check below would
 *  mislead; each is covered by name instead, and by e2e/roles.spec.ts end to end. */
const MIXED_ROUTES = new Set(["api/patient/[id]", "api/provider"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** `app/api/practice/users/route.ts` -> `api/practice/users`, the path a reader recognises. */
const routeName = (file: string) => path.dirname(path.relative("app", file)).split(path.sep).join("/");

test("every API route either checks a capability or is listed as one that does not need to", () => {
  const files = routeFiles("app");
  assert.ok(files.length > 5, "no route files found");

  const unguarded: string[] = [];
  for (const file of files) {
    const name = routeName(file);
    if (name in NOT_PROVIDER_ROUTES || name in ANY_ROLE_ROUTES || MIXED_ROUTES.has(name)) continue;
    if (!/requireCapability\(/.test(readFileSync(file, "utf8"))) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], "these routes check no role (§5.2); guard them, or say in NOT_PROVIDER_ROUTES what they check instead");
});

test("the list of routes that need no role names only routes that exist", () => {
  const names = new Set(routeFiles("app").map(routeName));
  const stale = [...Object.keys(NOT_PROVIDER_ROUTES), ...Object.keys(ANY_ROLE_ROUTES), ...MIXED_ROUTES].filter((name) => !names.has(name));
  assert.deepEqual(stale, [], "these are exempted from §5.2 but no longer exist; drop them so the list stays readable");
});

test("a route that needs no capability still needs a session", () => {
  // The exemption above is from the *role* check, never from the session: without this, listing a route in
  // ANY_ROLE_ROUTES would exempt it from §5.2 altogether and the file-wide test would stop looking at it.
  const unguarded = Object.keys(ANY_ROLE_ROUTES).filter((name) => {
    const source = readFileSync(path.join("app", ...name.split("/"), "route.ts"), "utf8");
    return !/requireProvider\(/.test(source) || /requireCapability\(/.test(source);
  });
  assert.deepEqual(unguarded, [], "these are exempt from the role check, so each must call requireProvider() and nothing else (lib/guard.ts)");
});

test("the two mixed-audience routes guard their provider half", () => {
  // Each serves the patient on their invite token and a provider on a visit id, so "has a capability check"
  // is not enough on its own: the check has to be the one that runs for the provider.
  const patientRoute = readFileSync(path.join("app", "api", "patient", "[id]", "route.ts"), "utf8");
  assert.match(patientRoute, /visitByToken\(id\)/, "the patient's token must be what is tried first");
  assert.match(patientRoute, /requireVerifiedPatient\(/, "and the token alone is not enough (T08, §5.3)");
  assert.match(patientRoute, /requireCapability\("summaries:read"\)/);
  assert.match(patientRoute, /requireVisitInPractice\(/);

  // POST /api/provider is the public sign-up, which is how the first session exists; GET is the dashboard.
  const providerRoute = readFileSync(path.join("app", "api", "provider", "route.ts"), "utf8");
  assert.match(providerRoute, /requireCapability\("visits:read"\)/);
  assert.match(providerRoute, /signUpPractice\(/, "sign-up must go through the create-only path");
});

// §5.3 is the patient's half of the same promise, and it fails the same way if a route forgets it: every
// route that takes an invite token has to ask for the session that token earned. The one exception is the
// route that mints it. Listed rather than inferred, so adding a token route is a deliberate decision about
// which of the two it is.
const TOKEN_ROUTES = ["api/consent", "api/sweetie", "api/upload", "api/patient/[id]", "api/dexcom/status", "api/dexcom/connect", "api/dexcom/demo"];

test("every route that takes an invite token asks for the verified session behind it", () => {
  const missing = TOKEN_ROUTES.filter((name) => {
    const file = path.join("app", ...name.split("/"), "route.ts");
    return !/requireVerifiedPatient\(/.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(missing, [], "these take a token but never check the session it names (§5.3, lib/guard.ts)");

  // The one that hands the session out cannot ask for it first.
  assert.equal(/requireVerifiedPatient\(/.test(readFileSync(path.join("app", "api", "verify", "route.ts"), "utf8")), false);
});
