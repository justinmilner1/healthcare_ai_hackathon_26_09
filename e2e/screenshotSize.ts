import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import exceptions from "./screenshot-exceptions.json";

// The size gate on design §12.3's screenshots (T61). Playwright runs it once, after the last spec
// (playwright.config.ts, globalTeardown).
//
// §12.3 exists so that both routines can *see* what they built, and a full-page shot of a screen whose
// height is the practice's own data is not something anybody can see: the filtered audit shot came out
// 1082 × 80,149 pixels, which ImageMagick refuses to open at all ("Image height exceeds user limit in
// IHDR"). Every one of those has been a bug in the spec that took it, and every one was found by a reviewer
// reading file sizes rather than by the run that wrote them. So the run reads them: a shot over MAX_HEIGHT
// fails the suite, by name, where it was taken.
//
// Only the files this run wrote are judged. `e2e/screenshots/` is gitignored and nothing empties it, so a
// developer's checkout holds whatever every earlier run left behind, and a stale file is not this run's
// verdict to give.
//
// What the gate does not do is decide how a shot should be taken instead — that is the spec's own business,
// and e2e/audit.spec.ts is one worked example: the desktop shoots the page, the phone brings the subject to
// the top of the viewport and shoots a screenful of it.

/** How tall a screenshot may be. A §6.5 phone screen is 375 × 667 at a device scale of 2.625, so this is
 *  two and a bit of them, or five and a half of the desktop project's — room for a page worth looking at,
 *  far short of a table that grows a row with every visit the suite books. */
export const MAX_HEIGHT = 4_000;

/** How far under the limit a listed shot has to come before its entry counts as left behind. Not the limit
 *  itself: a shot that lands at 3,900 one run and 4,100 the next would otherwise make the list flap. */
export const STALE_UNDER = 3_000;

export const SCREENSHOT_DIR = join("e2e", "screenshots");

export type Png = { width: number; height: number };
export type Shot = Png & { name: string };

/**
 * A PNG's dimensions, out of the IHDR chunk the first 24 bytes hold: the 8-byte signature, the chunk's
 * length and type, then width and height as big-endian 32-bit integers. The header is all this needs, so an
 * 80,000-pixel file costs the same 24-byte read as any other. `null` for anything that is not a PNG.
 */
export function pngSize(file: string): Png | null {
  const head = Buffer.alloc(24);
  const handle = openSync(file, "r");
  let read = 0;
  try {
    read = readSync(handle, head, 0, 24, 0);
  } finally {
    closeSync(handle);
  }
  if (read < 24) return null;
  if (head.readUInt32BE(0) !== 0x89504e47 || head.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The screenshots written since `since`, tallest first. */
export function screenshotsSince(since: number, dir: string = SCREENSHOT_DIR): Shot[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no directory at all: the suite wrote no screenshots, which is not this gate's complaint
  }
  const shots: Shot[] = [];
  for (const name of names) {
    if (!name.endsWith(".png")) continue;
    const file = join(dir, name);
    if (statSync(file).mtimeMs < since) continue;
    const size = pngSize(file);
    if (size) shots.push({ name, ...size });
  }
  return shots.sort((a, b) => b.height - a.height);
}

type Exception = { shots: string[]; reason: string; owner: string; expires: string };

/** The listed shots, by filename, with the entry that excused each one. */
function excused(): Map<string, Exception> {
  const byShot = new Map<string, Exception>();
  for (const entry of exceptions.exceptions as Exception[]) {
    for (const shot of entry.shots) byShot.set(shot, entry);
  }
  return byShot;
}

/** What the gate found: what is too tall and unexcused, what is excused by an entry that has run out, and
 *  which entries the run no longer needs. Separated from the throwing so it can be reasoned about. */
export function judge(shots: Shot[], today = new Date()): { tall: Shot[]; expired: Shot[]; stale: string[] } {
  const listed = excused();
  const tall: Shot[] = [];
  const expired: Shot[] = [];
  const stale: string[] = [];
  for (const shot of shots) {
    const entry = listed.get(shot.name);
    if (shot.height <= MAX_HEIGHT) {
      // Written, listed, and comfortably small: the ticket that owned it has landed and the entry is over.
      if (entry && shot.height < STALE_UNDER) stale.push(shot.name);
      continue;
    }
    if (!entry) tall.push(shot);
    else if (new Date(entry.expires) < today) expired.push(shot);
  }
  return { tall, expired, stale };
}

const sizes = (shots: Shot[]) => shots.map((shot) => `  ${shot.name}: ${shot.width} × ${shot.height}`).join("\n");

/** The run's own start, so a file an earlier run left behind is not read as this one's work. */
const runStartedAt = Date.now() - process.uptime() * 1_000;

export default async function assertScreenshotsAreReadable(): Promise<void> {
  const { tall, expired, stale } = judge(screenshotsSince(runStartedAt));
  const complaints: string[] = [];
  if (tall.length > 0) {
    complaints.push(
      `${tall.length} screenshot${tall.length === 1 ? " is" : "s are"} taller than ${MAX_HEIGHT}px, which is ` +
        `taller than anything a reviewer can open, so design §12.3 is not met by them:\n${sizes(tall)}\n` +
        `Take the viewport rather than the whole page on the project that produced it, with the subject ` +
        `scrolled to the top — or add the shot to e2e/screenshot-exceptions.json with the ticket that owns it.`,
    );
  }
  if (expired.length > 0) {
    complaints.push(
      `${expired.length} screenshot${expired.length === 1 ? " is" : "s are"} excused by an entry in ` +
        `e2e/screenshot-exceptions.json that has run out:\n${sizes(expired)}`,
    );
  }
  if (stale.length > 0) {
    complaints.push(
      `e2e/screenshot-exceptions.json excuses ${stale.length} shot${stale.length === 1 ? "" : "s"} that ` +
        `no longer need${stale.length === 1 ? "s" : ""} it. Delete the entr${stale.length === 1 ? "y" : "ies"}:\n` +
        stale.map((name) => `  ${name}`).join("\n"),
    );
  }
  if (complaints.length > 0) throw new Error(complaints.join("\n\n"));
}
