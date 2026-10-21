// Everything the Add-visit form and the CSV import agree on (design §2.2). Owner: identity.
//
// §2.2: "Staff add a visit: patient (new or existing by phone/email), visit date and time, visit type, what
// the patient called about, contact channel, and a recorded consent to be contacted (who recorded it, when,
// how). A CSV import creates a day's visits in one go."
//
// Pure, like lib/team.ts and lib/visits.ts: validators, the two small tables, and the CSV reader, with no
// database and no request. Three callers need exactly the same rules and must not drift —
//   the wizard (app/provider/dashboard.tsx, a client component, so nothing here may pull in Prisma),
//   POST /api/book,
//   POST /api/visits/import,
// — and lib/visitIntake.test.ts checks them without a Postgres. The writes are lib/visitStore.ts.
//
// `consentRecordedBy` is deliberately not a field here: who recorded the consent is the signed-in user, read
// from the session by the store, never a value a payload can set (§5.2). A CSV that names someone else is
// still recorded against the person who imported it.

import { normalizeEmail } from "./team";
import { knownVisitType, VISIT_TYPES } from "./visits";

/** Which channels the invite goes out on (§2.2 "contact channel", §8.1). `none` is staff saying they will
 *  hand the link over themselves — a visit with no consent to message, which is a legitimate row. */
export const CONTACT_CHANNELS = [
  { id: "both", label: "Text and email" },
  { id: "sms", label: "Text message" },
  { id: "email", label: "Email" },
  { id: "none", label: "Do not message" },
] as const;

export type ContactChannel = (typeof CONTACT_CHANNELS)[number]["id"];

export const isContactChannel = (v: unknown): v is ContactChannel => CONTACT_CHANNELS.some((c) => c.id === v);

export const channelLabel = (id: string | null | undefined) => CONTACT_CHANNELS.find((c) => c.id === id)?.label ?? "Not set";

/** How the consent was taken (§2.2's "how"). Stored on the visit as `consentChannel`. */
export const CONSENT_METHODS = [
  { id: "phone", label: "Over the phone" },
  { id: "in_person", label: "In person" },
  { id: "portal", label: "Patient portal" },
  { id: "email", label: "By email" },
  { id: "form", label: "Signed form" },
] as const;

export type ConsentMethod = (typeof CONSENT_METHODS)[number]["id"];

export const isConsentMethod = (v: unknown): v is ConsentMethod => CONSENT_METHODS.some((c) => c.id === v);

export const consentLabel = (id: string | null | undefined) => CONSENT_METHODS.find((c) => c.id === id)?.label ?? "Not recorded";

/** Which channels a given contact channel actually sends on. The invite job asks this rather than guessing. */
export function channelsOf(channel: string | null | undefined): ("sms" | "email")[] {
  if (channel === "sms") return ["sms"];
  if (channel === "email") return ["email"];
  if (channel === "none") return [];
  return ["sms", "email"]; // `both`, and anything older than this field
}

/** The inverse: the channel id a set of the two amounts to, so `channelLabel` can name a *subset* of what
 *  staff chose. T111 needs it because what staff chose and what this deployment can send on are two
 *  different things — a visit booked on "Text and email" where only SNS is configured is an invite going out
 *  by text message, and that is the channel the wizard should name. */
export function channelOf(channels: readonly ("sms" | "email")[]): ContactChannel {
  if (channels.includes("sms") && channels.includes("email")) return "both";
  return channels[0] ?? "none";
}

export const MAX_PATIENT_NAME = 120;
export const MAX_REASON = 280;

/** A patient's name as typed, collapsed and capped. Blank is null, which every caller reports as an error. */
export function cleanPatientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_PATIENT_NAME);
  return name || null;
}

/** What the patient called about, in the scheduler's words. Free text, capped; blank is null. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  return reason || null;
}

/**
 * A storable mobile number, or null. Digits, with a `+` only in front: SNS and Twilio both want E.164, and a
 * number typed as "(415) 555-0100" is the same number. A bare 10-digit string is left alone rather than
 * guessed into +1 — this app has no country to assume — so it stores what was typed and fails later honestly
 * if the carrier refuses it.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** A visit date and time, as ISO, from what a form or a CSV cell holds. Null for blank, undefined for junk:
 *  a date pending is normal (§4.4 allows a null `scheduledAt`), an unreadable one is a row error. */
export function parseScheduledAt(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return null;
  // "2026-10-15 09:30" is what a scheduler exports; the T is what Date wants. Both read as local time, which
  // is the practice's own clock and the only zone a front-desk CSV can mean.
  const at = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") : text);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** A visit type from an id ("follow_up") or from the label a scheduler exports ("Follow-up"). */
export function parseVisitType(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return null;
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  const byId = knownVisitType(key);
  if (byId !== "other") return byId;
  const byLabel = VISIT_TYPES.find((t) => t.label.toLowerCase() === text.toLowerCase());
  return byLabel?.id ?? undefined;
}

/** What one visit looks like once it has passed every rule above. The store turns this into rows. */
export type VisitDraft = {
  name: string;
  phone: string | null;
  email: string | null;
  scheduledAt: string | null;
  visitType: string | null;
  reason: string | null;
  channel: ContactChannel;
  /** Null only when `channel` is "none": nothing is being sent, so there is nothing to consent to. */
  consentMethod: ConsentMethod | null;
  /** When consent was taken, if staff recorded a time. Null means "when this row was created". */
  consentAt: string | null;
};

export type VisitInput = {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  scheduledAt?: unknown;
  visitType?: unknown;
  reason?: unknown;
  channel?: unknown;
  consentMethod?: unknown;
  consentAt?: unknown;
};

export type DraftResult = { ok: true; draft: VisitDraft } | { ok: false; errors: string[] };

/**
 * What is true about a draft that staff should see but that does not stop the visit being created.
 *
 * There is one, and it is T08's (§5.3): opening the invite link sends a six-digit code to the phone or email
 * on file, so a visit with neither cannot be opened by the patient at all — the link tells them to call the
 * office. That is a real state the front desk gets into (the appointment is booked today, the number arrives
 * tomorrow) and `POST /api/verify` already answers it honestly, so it stays creatable; it is not something to
 * find out about a week later, so both screens say it at the moment the visit is made.
 *
 * Which is also the answer to "may `do not message` carry an address": it should. The channel governs the
 * invite, and the address is what the code goes to whether or not an invite was ever sent.
 */
export function warningsFor(draft: Pick<VisitDraft, "phone" | "email">): string[] {
  if (draft.phone || draft.email) return [];
  return ["No phone or email on file, so this patient cannot open their link: opening it sends them a six-digit code."];
}

/**
 * One visit's worth of input, validated. Every error is a whole sentence a receptionist can act on, because
 * the same strings are shown under the wizard's fields and next to a CSV row.
 *
 * The consent rule is the §2.2 one and the reason this is not just field cleaning: a visit that will be
 * messaged needs a consent method *and* an address or number on the channel it will be messaged on. A visit
 * nobody will message needs neither.
 */
export function parseVisitDraft(input: VisitInput): DraftResult {
  const errors: string[] = [];

  const name = cleanPatientName(input.name);
  if (!name) errors.push("The patient's name is required.");

  const phone = normalizePhone(input.phone);
  if (input.phone && typeof input.phone === "string" && input.phone.trim() && !phone) {
    errors.push("That does not look like a phone number.");
  }
  const email = normalizeEmail(input.email);
  if (input.email && typeof input.email === "string" && input.email.trim() && !email) {
    errors.push("That does not look like an email address.");
  }

  const scheduledAt = parseScheduledAt(input.scheduledAt);
  if (scheduledAt === undefined) errors.push("The visit date and time could not be read. Use 2026-10-15 09:30.");

  const visitType = parseVisitType(input.visitType);
  if (visitType === undefined) errors.push(`Visit type must be one of: ${VISIT_TYPES.map((t) => t.id).join(", ")}.`);

  // "both" is the form's default, and what a visit created before T07 behaved as. The CSV reader passes an
  // explicit "none" rather than leaning on this, for the reason given in parseVisitCsv.
  const channelRaw = input.channel === undefined || input.channel === null || input.channel === "" ? "both" : input.channel;
  const channel = isContactChannel(channelRaw) ? channelRaw : null;
  if (!channel) errors.push(`Contact channel must be one of: ${CONTACT_CHANNELS.map((c) => c.id).join(", ")}.`);

  const consentRaw = input.consentMethod === undefined || input.consentMethod === null || input.consentMethod === "" ? null : input.consentMethod;
  const consentMethod = consentRaw === null ? null : isConsentMethod(consentRaw) ? consentRaw : undefined;
  if (consentMethod === undefined) errors.push(`Consent must be recorded as one of: ${CONSENT_METHODS.map((c) => c.id).join(", ")}.`);

  const consentAt = parseScheduledAt(input.consentAt);
  if (consentAt === undefined) errors.push("The consent date could not be read. Use 2026-10-15 09:30.");

  if (channel && channel !== "none") {
    if (!consentMethod) errors.push("Record how the patient's consent to be contacted was taken before sending anything.");
    const wanted = channelsOf(channel);
    if (wanted.includes("sms") && !phone) errors.push("A text message needs a mobile number.");
    if (wanted.includes("email") && !email) errors.push("An emailed invite needs an email address.");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name: name as string,
      phone,
      email,
      scheduledAt: scheduledAt as string | null,
      visitType: visitType as string | null,
      reason: cleanReason(input.reason),
      channel: channel as ContactChannel,
      consentMethod: (consentMethod ?? null) as ConsentMethod | null,
      consentAt: (consentAt ?? null) as string | null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The CSV import (§2.2). A day of visits in one file, previewed before anything is written.

/** The header the practice's scheduler is asked to export, in order. Also what the download template says. */
export const CSV_COLUMNS = ["name", "phone", "email", "scheduled_at", "visit_type", "reason", "channel", "consent", "consent_at"] as const;

/** Spellings seen in real exports, mapped onto the columns above. Unknown columns are ignored, not an error:
 *  a scheduler's export carries its own extra fields and refusing the file over them would be useless. */
const HEADER_ALIASES: Record<string, (typeof CSV_COLUMNS)[number]> = {
  name: "name",
  patient: "name",
  patient_name: "name",
  phone: "phone",
  mobile: "phone",
  phone_number: "phone",
  cell: "phone",
  email: "email",
  email_address: "email",
  scheduled_at: "scheduled_at",
  appointment: "scheduled_at",
  appointment_at: "scheduled_at",
  datetime: "scheduled_at",
  date_time: "scheduled_at",
  when: "scheduled_at",
  visit_type: "visit_type",
  type: "visit_type",
  appointment_type: "visit_type",
  reason: "reason",
  notes: "reason",
  called_about: "reason",
  chief_complaint: "reason",
  channel: "channel",
  contact_channel: "channel",
  consent: "consent",
  consent_method: "consent",
  consent_how: "consent",
  consent_at: "consent_at",
  consent_date: "consent_at",
};

/** A header cell as a lookup key: "Patient Name" and "patient_name" are the same column. */
const headerKey = (cell: string) => cell.trim().toLowerCase().replace(/^﻿/, "").replace(/[\s-]+/g, "_");

/** One line of CSV into cells, honouring double quotes and "" as an escaped quote. Small on purpose: this
 *  reads a front-desk export, not arbitrary RFC 4180 with embedded newlines, and a cell with a newline in it
 *  is reported as a row error rather than silently joined. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else cell += c;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** One row of the preview: what the file said, what it parsed to, and why it cannot be created. */
export type CsvRow = {
  /** The line in the file, counting the header as line 1, so an error names what the person is looking at. */
  line: number;
  /** The patient's name as the file spelled it, for the preview table. Empty when the file had no name. */
  name: string;
  draft: VisitDraft | null;
  errors: string[];
  /** True of the row, and not a reason to refuse it: see warningsFor. Empty on a row that has errors. */
  warnings: string[];
};

export type CsvParse = {
  /** The recognised columns, in file order. The preview prints this so a mis-mapped export is visible. */
  columns: string[];
  /** Header cells that matched nothing, named so a typo'd column is obvious rather than silently empty. */
  ignored: string[];
  rows: CsvRow[];
  /** A whole-file refusal: no header, no data rows, missing a name column. Rows are empty when this is set. */
  error?: string;
};

export const MAX_CSV_ROWS = 500;

/**
 * A day's visits out of a CSV, each row parsed on its own so one bad line never costs the other 24 (§2.2's
 * "preview and per-row errors"). Nothing is written here: the caller shows this, and only then asks for the
 * valid rows to be created.
 */
export function parseVisitCsv(text: string): CsvParse {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headerIndex = lines.findIndex((l) => l.trim());
  if (headerIndex < 0) return { columns: [], ignored: [], rows: [], error: "That file is empty." };

  const header = splitCsvLine(lines[headerIndex]);
  const mapped = header.map((cell) => HEADER_ALIASES[headerKey(cell)] ?? null);
  const ignored = header.filter((cell, i) => cell && mapped[i] === null);
  if (!mapped.includes("name")) {
    return {
      columns: mapped.filter((c): c is (typeof CSV_COLUMNS)[number] => c !== null),
      ignored,
      rows: [],
      error: `No patient name column. The first line has to be a header; ${CSV_COLUMNS.join(",")} is the one to export.`,
    };
  }

  const rows: CsvRow[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // a blank line between days, or the trailing newline every editor adds
    if (rows.length >= MAX_CSV_ROWS) {
      return { columns: mapped.filter((c): c is (typeof CSV_COLUMNS)[number] => c !== null), ignored, rows, error: `That file has more than ${MAX_CSV_ROWS} rows. Split it by day.` };
    }
    const cells = splitCsvLine(line);
    const value = (column: (typeof CSV_COLUMNS)[number]) => {
      const at = mapped.indexOf(column);
      return at < 0 ? "" : (cells[at] ?? "");
    };
    const input: VisitInput = {
      name: value("name"),
      phone: value("phone"),
      email: value("email"),
      scheduledAt: value("scheduled_at"),
      visitType: value("visit_type"),
      reason: value("reason"),
      // A blank or absent channel column means *nothing is sent* for that row — the one place this differs
      // from the form, where the default is "both". A scheduler's export knows about appointments and not
      // about consent, so a file that says nothing about either cannot be read as permission to message
      // anyone (§2.2): the rows import, staff see them on the dashboard, and the link is theirs to hand over.
      channel: value("channel") || "none",
      consentMethod: value("consent"),
      consentAt: value("consent_at"),
    };
    const parsed = parseVisitDraft(input);
    const errors = parsed.ok ? [] : parsed.errors;
    if (cells.length !== header.length) {
      errors.unshift(`This row has ${cells.length} ${cells.length === 1 ? "cell" : "cells"} and the header has ${header.length}.`);
    }
    const draft = errors.length ? null : (parsed as { draft: VisitDraft }).draft;
    rows.push({ line: i + 1, name: cleanPatientName(value("name")) ?? "", draft, errors, warnings: draft ? warningsFor(draft) : [] });
  }

  if (!rows.length) return { columns: mapped.filter((c): c is (typeof CSV_COLUMNS)[number] => c !== null), ignored, rows, error: "That file has a header and no visits under it." };
  return { columns: mapped.filter((c): c is (typeof CSV_COLUMNS)[number] => c !== null), ignored, rows };
}

/** The example file the import screen offers, so a practice has something to fill in. Synthetic by design. */
export const CSV_TEMPLATE = [
  CSV_COLUMNS.join(","),
  "Sam Taylor,+14155550100,sam@example.com,2026-10-15 09:30,follow_up,mornings running high,both,phone,",
  "Ada Rivera,+14155550101,,2026-10-15 10:15,medication,new insulin dose,sms,in_person,",
].join("\n");
