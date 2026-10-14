// Who may do what (design §5.2). Owner: identity.
//
// §5.2 names three roles and what each is for: "admin manages users and practice settings; clinician sees and
// reviews summaries; staff creates visits and sends invites". That sentence is the table below, and nothing
// else in the app is allowed to have an opinion about it — a route asks for a capability, never for a role, so
// adding a role later is one line here instead of a grep across app/api.
//
// Pure data and two functions, no database and no request, so the rules read in one screen and lib/access.test.ts
// can check every cell of the table. The guards that turn a capability into a 401, 403 or 404 are lib/guard.ts.
//
// Admin is deliberately a superset of clinician for the summary capabilities: a one-doctor practice has exactly
// one user, and that user is its admin (lib/authAdapter.ts), so an admin who could not read a summary would be
// locked out of the product. Admin is *not* given anything staff-only beyond visits, because "manages the
// practice" already covers booking into it.

export const ROLES = ["admin", "clinician", "staff"] as const;
export type Role = (typeof ROLES)[number];

/** What an invite defaults to when the form sends nothing: the least that can still do a day's work. */
export const DEFAULT_ROLE: Role = "staff";

const LABELS: Record<Role, string> = { admin: "Admin", clinician: "Clinician", staff: "Staff" };

/** One line per role, shown next to the invite form so an admin picks on purpose rather than by name. */
const DESCRIPTIONS: Record<Role, string> = {
  admin: "Manages the practice, its settings and who works in it. Reads summaries too.",
  clinician: "Reads and reviews Sour summaries for this practice's visits.",
  staff: "Books visits and sends patient invites. Does not read summaries.",
};

/** Every capability a provider route can ask for, and the roles that hold it. The whole of §5.2. */
export const CAPABILITIES = {
  /** See the practice's visit list and who is where in the pre-visit flow. Everyone who works here. */
  "visits:read": ["admin", "clinician", "staff"],
  /** Book a visit for a patient (§2.2). */
  "visits:create": ["admin", "staff"],
  /** Send or resend a patient's invite link (§2.3). */
  "visits:invite": ["admin", "staff"],
  /** Open a Sour one-pager, or ask it a follow-up (§2.6). Clinical, so not staff. */
  "summaries:read": ["admin", "clinician"],
  /** Ask for a summary to be written or rewritten. */
  "summaries:generate": ["admin", "clinician"],
  /** Invite a user, change a role (§2.1). */
  "users:manage": ["admin"],
  /** Rename the practice, change its retention window (§2.8, §10.4). */
  "practice:manage": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as Capability[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Whether a role holds a capability. A role this build does not know — a row written by an older version, or
 * a value someone typed into the database — holds nothing: the default is no, so a typo locks a user out
 * instead of letting them in.
 */
export function can(role: string | null | undefined, capability: Capability): boolean {
  if (!isRole(role)) return false;
  return (CAPABILITIES[capability] as readonly string[]).includes(role);
}

/** The capabilities a role holds, in table order. What the settings page prints under each person. */
export function capabilitiesOf(role: string | null | undefined): Capability[] {
  return CAPABILITY_NAMES.filter((capability) => can(role, capability));
}

/** The role in the words the settings page uses. An unknown role is shown as it was stored, not hidden. */
export const roleLabel = (role: string | null | undefined): string => (isRole(role) ? LABELS[role] : String(role ?? "unknown"));

export const roleDescription = (role: Role): string => DESCRIPTIONS[role];
