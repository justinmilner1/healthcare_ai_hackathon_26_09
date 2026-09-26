// Dexcom Clarity CSV parsing, spike detection, time in range. Owner: Nisarga.
// Spec (AGENTS.md): spike = rise of >= 50 mg/dL within 2 h with peak > 180; merge spikes closer than 1 h.
// Time in range = share of readings in 70..180.

import type { GlucoseReading, Spike } from "./types";

const RISE_MGDL = 50;
const WINDOW_MS = 2 * 60 * 60 * 1000;
const PEAK_MIN = 180;
const MERGE_MS = 60 * 60 * 1000;

/** Parse a Dexcom Clarity export. Tolerates the metadata rows at the top; keeps only EGV rows. */
export function parseClarityCsv(text: string): GlucoseReading[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const tsIdx = header.findIndex((h) => h.startsWith("timestamp"));
  const typeIdx = header.findIndex((h) => h === "event type");
  const valIdx = header.findIndex((h) => h.startsWith("glucose value"));
  if (tsIdx < 0 || valIdx < 0) return [];

  const out: GlucoseReading[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    if (typeIdx >= 0 && cols[typeIdx]?.trim() !== "EGV") continue;
    const ts = cols[tsIdx]?.trim();
    const raw = cols[valIdx]?.trim();
    if (!ts || !raw) continue;
    // Clarity writes "Low" / "High" for out-of-range sensor values.
    const mgdl = raw === "Low" ? 40 : raw === "High" ? 400 : Number(raw);
    if (!Number.isFinite(mgdl)) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    out.push({ t: d.toISOString(), mgdl });
  }
  out.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}

export function timeInRange(readings: GlucoseReading[], lo = 70, hi = 180): number {
  if (readings.length === 0) return 0;
  const inRange = readings.filter((r) => r.mgdl >= lo && r.mgdl <= hi).length;
  return inRange / readings.length;
}

export function averageGlucose(readings: GlucoseReading[]): number {
  if (readings.length === 0) return 0;
  return Math.round(readings.reduce((s, r) => s + r.mgdl, 0) / readings.length);
}

/** Detect spikes. Returns them sorted by size of rise, largest first. */
export function detectSpikes(readings: GlucoseReading[]): Spike[] {
  const rs = readings.map((r) => ({ ...r, ms: Date.parse(r.t) }));
  const spikes: Spike[] = [];
  let i = 0;
  while (i < rs.length) {
    // Find the minimum in the trailing window, then the max ahead within WINDOW_MS.
    let peakIdx = i;
    for (let j = i + 1; j < rs.length && rs[j].ms - rs[i].ms <= WINDOW_MS; j++) {
      if (rs[j].mgdl > rs[peakIdx].mgdl) peakIdx = j;
    }
    // Onset is the last trough before the peak, not the first point in the window.
    let startIdx = i;
    for (let j = i; j <= peakIdx; j++) if (rs[j].mgdl <= rs[startIdx].mgdl) startIdx = j;
    const rise = rs[peakIdx].mgdl - rs[startIdx].mgdl;
    if (rise >= RISE_MGDL && rs[peakIdx].mgdl > PEAK_MIN) {
      spikes.push({ start: rs[startIdx].t, peak: rs[peakIdx].t, from: rs[startIdx].mgdl, to: rs[peakIdx].mgdl });
      i = peakIdx + 1;
    } else {
      i++;
    }
  }
  // Merge spikes whose starts are closer than MERGE_MS; keep the bigger peak.
  const merged: Spike[] = [];
  for (const s of spikes) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(s.start) - Date.parse(last.peak) < MERGE_MS) {
      if (s.to > last.to) merged[merged.length - 1] = { ...last, peak: s.peak, to: s.to };
    } else {
      merged.push(s);
    }
  }
  return merged.sort((a, b) => b.to - b.from - (a.to - a.from));
}

/** Thin out readings for charts. Keeps every nth point. */
export function downsample(readings: GlucoseReading[], maxPoints = 600): GlucoseReading[] {
  if (readings.length <= maxPoints) return readings;
  const step = Math.ceil(readings.length / maxPoints);
  return readings.filter((_, i) => i % step === 0);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
