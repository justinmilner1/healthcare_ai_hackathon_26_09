"""Generate synthetic 7-day demo data: Dexcom Clarity CSV, Google Timeline JSON, WHOOP CSV, visits.csv.
Deterministic (seeded). Dates fixed to 2026-09-19..2026-09-25 so files never go stale;
parsers treat the latest timestamp in the file as 'now'."""
import csv, json, math, random, os, sys
from datetime import datetime, timedelta

random.seed(7)
out = sys.argv[1] if len(sys.argv) > 1 else "data"
os.makedirs(out, exist_ok=True)

start = datetime(2026, 9, 19, 0, 0, 0)
days = 7

# Places (SF). Visits drive the meal spikes.
places = [
    ("Chipotle Market St", 37.7794, -122.4143, "ChIJ_chipotle_demo"),
    ("Blue Bottle Coffee", 37.7766, -122.4231, "ChIJ_bluebottle_demo"),
    ("Home", 37.7599, -122.4148, "ChIJ_home_demo"),
    ("Office", 37.7899, -122.4009, "ChIJ_office_demo"),
    ("Pizzeria Delfina", 37.7614, -122.4241, "ChIJ_delfina_demo"),
    ("Gym", 37.7691, -122.4312, "ChIJ_gym_demo"),
]
by_name = {p[0]: p for p in places}

# Daily plan: (hour, minute, place, duration_min, carb_load 0..1)
plans = {
    0: [(8, 15, "Blue Bottle Coffee", 25, 0.5), (12, 10, "Chipotle Market St", 40, 0.9), (18, 30, "Home", 600, 0.4)],
    1: [(9, 0, "Office", 480, 0.0), (12, 30, "Chipotle Market St", 35, 0.9), (20, 15, "Pizzeria Delfina", 75, 1.0)],
    2: [(7, 30, "Gym", 60, 0.0), (9, 0, "Office", 480, 0.0), (19, 0, "Home", 600, 0.4)],
    3: [(8, 20, "Blue Bottle Coffee", 20, 0.5), (12, 15, "Office", 300, 0.3), (20, 45, "Pizzeria Delfina", 70, 1.0)],
    4: [(9, 0, "Office", 480, 0.0), (13, 0, "Chipotle Market St", 30, 0.9), (18, 0, "Gym", 60, 0.0)],
    5: [(10, 0, "Home", 300, 0.3), (14, 0, "Blue Bottle Coffee", 30, 0.6), (19, 30, "Home", 600, 0.4)],
    6: [(8, 0, "Gym", 60, 0.0), (12, 0, "Home", 240, 0.3), (18, 15, "Chipotle Market St", 40, 0.9)],
}
sleep = [7.1, 5.4, 7.8, 5.9, 6.6, 8.2, 7.4]   # short nights after late dinners out
recovery = [71, 38, 82, 41, 60, 88, 75]

segments, visits_rows, meals = [], [], []
for d in range(days):
    day = start + timedelta(days=d)
    for (h, m, place, dur, carb) in plans[d]:
        s = day.replace(hour=h, minute=m)
        e = s + timedelta(minutes=dur)
        name, lat, lng, pid = by_name[place]
        # Dexcom exports are local time with no offset; Timeline exports carry an offset.
        # Pacific (-07:00) so the two line up on a laptop in San Francisco.
        segments.append({
            "startTime": s.isoformat() + "-07:00", "endTime": e.isoformat() + "-07:00",
            "visit": {"hierarchyLevel": 0, "probability": 0.9,
                      "topCandidate": {"placeId": pid, "semanticType": "UNKNOWN",
                                       "probability": 0.8, "placeLocation": {"latLng": f"geo:{lat},{lng}"}}},
        })
        visits_rows.append([s.isoformat(), e.isoformat(), name, lat, lng])
        if carb > 0:
            meals.append((e, carb))  # spike begins as they leave

# Glucose: baseline + circadian + meal spikes + noise, every 5 min
readings = []
t = start
end = start + timedelta(days=days)
while t < end:
    base = 118 + 8 * math.sin((t.hour + t.minute / 60) / 24 * 2 * math.pi)
    g = base
    for (mt, carb) in meals:
        dt = (t - mt).total_seconds() / 60
        if 0 <= dt <= 180:
            g += carb * 95 * math.exp(-((dt - 55) ** 2) / (2 * 30 ** 2))
    g += random.gauss(0, 4)
    readings.append((t, int(round(max(55, min(320, g))))))
    t += timedelta(minutes=5)

# Dexcom Clarity CSV (EGV rows; header + a few meta rows like the real export)
hdr = ["Index", "Timestamp (YYYY-MM-DDThh:mm:ss)", "Event Type", "Event Subtype", "Patient Info", "Device Info",
       "Source Device ID", "Glucose Value (mg/dL)", "Insulin Value (u)", "Carb Value (grams)", "Duration (hh:mm:ss)",
       "Glucose Rate of Change (mg/dL/min)", "Transmitter Time (Long Integer)", "Transmitter ID"]
with open(f"{out}/dexcom_clarity_sample.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(hdr)
    w.writerow([1, "", "FirstName", "", "Sam", "", "", "", "", "", "", "", "", ""])
    w.writerow([2, "", "LastName", "", "Sample", "", "", "", "", "", "", "", "", ""])
    w.writerow([3, "", "Device", "", "", "Dexcom G7", "SM12345678", "", "", "", "", "", "", ""])
    for i, (ts, g) in enumerate(readings, start=4):
        w.writerow([i, ts.strftime("%Y-%m-%dT%H:%M:%S"), "EGV", "", "", "Dexcom G7", "SM12345678", g, "", "", "", "", "", "ABC123"])

with open(f"{out}/timeline_sample.json", "w") as f:
    json.dump({"semanticSegments": segments}, f, indent=1)

with open(f"{out}/visits.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["start", "end", "place", "lat", "lng"]); w.writerows(visits_rows)

with open(f"{out}/whoop_sample.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Cycle start time", "Cycle end time", "Recovery score %", "Asleep duration (min)", "Sleep performance %"])
    for d in range(days):
        cs = (start + timedelta(days=d)).replace(hour=22)
        w.writerow([cs.strftime("%Y-%m-%d %H:%M:%S"), (cs + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S"),
                    recovery[d], int(sleep[d] * 60), int(min(100, sleep[d] / 8 * 100))])

print(f"wrote {len(readings)} readings, {len(segments)} visits, {days} nights to {out}/")
