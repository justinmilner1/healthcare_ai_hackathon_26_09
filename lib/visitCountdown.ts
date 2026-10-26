// How long until the appointment, as a patient counts it (design §2.7, T162).
//
// The patient summary's hero opens with one sentence about the appointment, and until this module it did
// the arithmetic inline in `app/patient/[id]/page.tsx` as `Math.ceil((apptAt - now) / 86400000)` — how many
// 24-hour spans fit in the gap. That is not what "days until" means to anyone reading it. Measured from
// 03:42 on the 26th, an appointment at 17:00 **the same day** is 13 hours out, which ceils to 1, and the
// page told the patient their visit was *tomorrow*; a genuine next-morning appointment is more than 24
// hours out, ceils to 2, and read "2 days". A patient who believes the first of those misses the visit
// this product exists to prepare them for.
//
// So the count here is a calendar difference: local midnight to local midnight, which is the question the
// sentence is actually asking. The zone is the runtime's own, which is the one zone this app resolves wall
// times in — `parseScheduledAt` (lib/visitIntake.ts) reads the wizard's zone-less `datetime-local` field as
// local time, so a visit booked for 09:30 means 09:30 on that clock. There is no per-practice zone on
// `Practice` today and this module does not invent one; when there is, both ends take it together.
//
// Pure functions in their own module, both because the page is a client component (nothing here may reach
// the database or the model) and because §12.1 wants the decision under test — a sentence that lives in a
// page is a sentence only a screenshot can check, and a visible off-by-one survived in one for weeks.

import { countOf } from "./plural";

const DAY_MS = 86_400_000;

/** Midnight at the start of `at`'s own local day. */
const startOfLocalDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate());

/**
 * Whole calendar days from `now`'s local day to `apptAt`'s: `0` for later today (or earlier today), `1` for
 * tomorrow whatever the time is now, negative for a day already past. `null` when there is no appointment
 * time or it cannot be read, which is the one case that has no number and a sentence of its own below.
 *
 * Rounded rather than divided exactly because two local midnights are not always a whole number of
 * milliseconds apart: a daylight-saving change in between makes the span 23 or 25 hours, and an unrounded
 * quotient would lose or gain the day it straddles.
 */
export function calendarDaysUntil(apptAt: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (apptAt === null || apptAt === undefined || apptAt === "") return null;
  const at = apptAt instanceof Date ? apptAt : new Date(apptAt);
  if (Number.isNaN(at.getTime())) return null;
  return Math.round((startOfLocalDay(at).getTime() - startOfLocalDay(now).getTime()) / DAY_MS);
}

/**
 * The hero's line about the appointment (design §2.7). Four shapes, one per thing the patient needs to know:
 * the day itself when it is today or tomorrow, a count when it is further out, and no claim about when at
 * all once the day has passed or when nothing was booked — the last of those is the wording the page has
 * always used for a visit with no time on it, and it is the only branch that is not about a date.
 */
export function visitCountdownSentence(
  apptAt: string | Date | null | undefined,
  providerName: string,
  now: Date = new Date(),
): string {
  const days = calendarDaysUntil(apptAt, now);
  if (days === null) return `Getting ready for your visit with ${providerName}.`;
  if (days >= 2) return `${countOf(days, "day")} until your visit with ${providerName}.`;
  if (days === 1) return `Your visit with ${providerName} is tomorrow.`;
  if (days === 0) return `Your visit with ${providerName} is today.`;
  return `Your visit with ${providerName}.`;
}
