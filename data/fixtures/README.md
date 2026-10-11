# Parser fixtures

Synthetic inputs for the unit tests in `lib/*.test.ts`. Design §9.4: every parser has fixture files here.
Nothing in this folder comes from a real person or a real export; the names, place ids and device serials are
invented. Load them with the helpers in `lib/fixtures.ts`, never with a hand-rolled path.

Two rules keep the assertions stable on any machine:

- Timestamps in the Clarity and WHOOP files have **no UTC offset**, exactly as the real exports write them
  (device-local time). A test that asserts on an instant calls `pinUtcTimeZone()` from `lib/fixtures.ts` first.
- Timestamps in the Timeline and visits files carry an explicit **`+00:00`** offset, so the Timeline visits line
  up with the Clarity window whatever zone the machine is in. Real exports carry the device's own offset
  (`-07:00` and the like); the parser only ever sees an offset, so the value of it changes nothing.

| File | Format | What it is for |
|---|---|---|
| `clarity_window.csv` | Dexcom Clarity, 84 EGV rows, 5 min apart | 2026-09-19 06:00–12:55. One breakfast spike (96 → 214, onset 07:00, peak 08:00) and one urgent low (48 mg/dL for 20 min from 10:55). TIR 64/84; 9 readings below 70, so time-below-range is over the 4% limit. Two safety flags, one spike. |
| `clarity_sustained_high.csv` | Dexcom Clarity, 36 EGV rows, 5 min apart | 2026-09-20 19:00–21:55. A single run above 250 mg/dL lasting 100 minutes, which is the only input that raises the sustained-high flag. |
| `clarity_edge_cases.csv` | Dexcom Clarity, deliberately messy | Every row the parser has to cope with: the three metadata rows, a quoted field holding a comma, Clarity's `Low` and `High` sentinels, a Calibration and an Insulin row, a row with no glucose value, an unparseable timestamp, a non-numeric value, and two rows out of order. Four readings survive. |
| `timeline_android.json` | Google Maps Timeline, Android shape (`semanticSegments`) | `placeLocation` in the `{ latLng: "geo:…" }` form. Holds a visit a week stale (dropped by the 7-day window), a walking segment with no `visit` key, and a visit with no `placeLocation`. Three visits survive: cafe 06:10–06:50, office 09:00–17:00, pizzeria 19:30–20:40. |
| `timeline_ios.json` | Google Maps Timeline, iOS shape (top-level array) | The same cafe and pizzeria visits with `placeLocation` in the `"37.77°, -122.42°"` string form, plus a driving segment to drop. |
| `visits.csv` | Hand labels: `start,end,place,lat,lng` | Names for the three Timeline places (place names are not in the export). The coordinates are exact, so `labelVisits` matches on proximity as well as on place id. |
| `whoop_cycles.csv` | WHOOP cycle export | Three nights with `Recovery score %` and `Asleep duration (min)`; the middle night is the short one (318 min = 5.3 h) after a late dinner. |
| `whoop_alt_headers.csv` | WHOOP export, other column names | `Date` and `Sleep duration (min)` instead, and no recovery column, to hold the loose header matching honest. Includes an unparseable date and a non-numeric duration; two nights survive. |

The week-long demo data the seed script loads is a different thing and lives one folder up: `data/*_sample.*`.
