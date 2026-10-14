# T11 — uploads to S3 with a local filesystem adapter

T11 moves the bytes of an uploaded export out of the database and behind `lib/storage.ts` (design §3.3), and
puts the §9.1 gates — 20 MB cap, type sniffing — in front of every parser. Two screens show it.

| File | Screen |
|---|---|
| `desktop-patient-intake-uploads.png` | `/s/<token>/intake`, Connect step, after a Clarity CSV and a zip |
| `mobile-patient-intake-uploads.png` | the same screen on a Pixel 7 profile |
| `desktop-provider-sour-generated.png` | `/provider/<id>?visit=<id>` for the seeded patient |

On the intake screen the Dexcom card reads "84 records securely added": the route parsed the file, the adapter
wrote the bytes under `visits/<visitId>/dexcom/<uuid>.csv`, and the row kept the key. The WHOOP card is a
Takeout zip offered as a CSV — the mistake patients actually make — refused by the magic-byte gate before any
parser saw it, with the sentence the patient needs: "that looks like a zip file — unzip it and upload the file
inside". The Dexcom card beside it stays connected, because a refused upload changes nothing.

The mobile shot is why `.sourceError` no longer clips to one line. It used to end at "…unzip it and upload…",
exactly where the instruction began.

These are from the run after `main` was merged in (T05 sign-in, T27 middleware, T31 config checks), so the
intake screen here is the one a patient reaches today.

The Sour screenshot is the seeded patient, whose four sample files now go through the same adapter in
`npm run seed`: 2,016 readings, Timeline and WHOOP, all read back from `UploadData.parsed` with the raw bytes
on disk rather than in Postgres.
