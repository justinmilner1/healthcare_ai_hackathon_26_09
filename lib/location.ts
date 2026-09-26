// Google Maps Timeline parsing. Owner: Robbert.
// Android export: { semanticSegments: [...] }. iOS export: top-level array.
// Keep only segments with a `visit` key within the last 7 days of the file (latest endTime = "now",
// so sample files never go stale). placeLocation is "37.77°, -122.41°" or { latLng: "geo:37.77,-122.41" }.
// Place names are not in the export: join on placeId, then fall back to visits.csv by proximity.

import type { Visit } from "./types";

type RawSegment = {
  startTime?: string;
  endTime?: string;
  visit?: { topCandidate?: { placeId?: string; placeLocation?: unknown } };
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function parseTimeline(jsonText: string, opts: { now?: Date; windowMs?: number } = {}): Visit[] {
  const data = JSON.parse(jsonText) as unknown;
  const segments: RawSegment[] = Array.isArray(data)
    ? (data as RawSegment[])
    : ((data as { semanticSegments?: RawSegment[] }).semanticSegments ?? []);

  const visits: Visit[] = [];
  for (const s of segments) {
    if (!s.visit || !s.startTime || !s.endTime) continue;
    const loc = parseLatLng(s.visit.topCandidate?.placeLocation);
    if (!loc) continue;
    visits.push({
      start: new Date(s.startTime).toISOString(),
      end: new Date(s.endTime).toISOString(),
      place: s.visit.topCandidate?.placeId ?? "Unknown place",
      lat: loc.lat,
      lng: loc.lng,
      placeId: s.visit.topCandidate?.placeId,
    });
  }
  if (visits.length === 0) return [];

  const latest = opts.now?.getTime() ?? Math.max(...visits.map((v) => Date.parse(v.end)));
  const cutoff = latest - (opts.windowMs ?? SEVEN_DAYS_MS);
  return visits.filter((v) => Date.parse(v.start) >= cutoff).sort((a, b) => a.start.localeCompare(b.start));
}

/** Hand-labelled visits.csv: start,end,place,lat,lng */
export function parseVisitsCsv(text: string): Visit[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: Visit[] = [];
  for (const line of lines.slice(1)) {
    const [start, end, place, lat, lng] = line.split(",").map((c) => c.trim());
    if (!start || !end || !place) continue;
    out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), place, lat: Number(lat), lng: Number(lng) });
  }
  return out;
}

/** Give Timeline visits human names from a labelled list, by placeId or by being within ~100 m. */
export function labelVisits(visits: Visit[], labelled: Visit[]): Visit[] {
  if (labelled.length === 0) return visits;
  return visits.map((v) => {
    const byId = v.placeId && labelled.find((l) => l.placeId && l.placeId === v.placeId);
    const near = byId ?? labelled.find((l) => distanceM(l.lat, l.lng, v.lat, v.lng) < 100);
    return near ? { ...v, place: near.place } : v;
  });
}

function parseLatLng(raw: unknown): { lat: number; lng: number } | null {
  let s: string | undefined;
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object" && "latLng" in raw) s = String((raw as { latLng: unknown }).latLng);
  if (!s) return null;
  const m = s.replace(/geo:/, "").match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)°?/);
  if (!m) return null;
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
