# Sample data

Synthetic, 7 days (2026-09-19 to 2026-09-25), one fake patient. Regenerate with `python3 scripts/gen_samples.py data`.

| File | Format | Rows |
|---|---|---|
| `dexcom_clarity_sample.csv` | Dexcom Clarity export (EGV rows, 5 min) | 2016 |
| `timeline_sample.json` | Google Maps Timeline, Android shape (`semanticSegments`) | 21 visits |
| `visits.csv` | Hand labels for the Timeline places: `start,end,place,lat,lng` | 21 |
| `whoop_sample.csv` | WHOOP cycle export | 7 nights |

The glucose has meal spikes timed to the visits (Chipotle at lunch, Pizzeria Delfina late dinners) and short sleep after the late dinners, so Sour has real patterns to find.

Real exports from a teammate go in this folder too but are gitignored. Only `*_sample.*`, `visits.csv`, and this README are committed.
