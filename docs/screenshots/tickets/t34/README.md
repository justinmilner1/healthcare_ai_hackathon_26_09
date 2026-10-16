# T34 screenshots

From `bash scripts/agent-check.sh` on branch `t34-compliance-checklist`.

This ticket adds no UI: it is `docs/COMPLIANCE.md`, and the only product change beside it is a paragraph in
the README pointing at it. So these are not shots of something new. They are the screens the checklist makes
claims about, read back as evidence that the claim is true of the build rather than true of the design — and
two of them are where the document's open risks are visible.

| File | The row it is evidence for |
|---|---|
| `desktop-provider-audit.png` | **Audit controls.** The page's own subtitle is §10.2 in a sentence, and the seven rows are the categories the checklist lists: three sends with the channel and whether the provider took it, a deletion, a clinician's read of the uploads with `part: uploads`, the consent, and `method: one_time_code` for the patient link. No name, no number, no finding in any `detail` — which is the "No PHI in the record" row. `patient.consent_accepted` showing as its stored key rather than a label is open ticket T51, and is why the consent row of the access-control table is `partial` rather than `in place`. |
| `desktop-provider-audit-deletion.png` | **"The audit record survives the data."** The same page filtered to `Patient data deleted`, after `e2e/deletion.spec.ts` has erased the patient. One row, the clinician who asked for it, and counts of what went — 1 visit, 1 upload, 2 summaries, 1 object, 0 orphans. The patient it names no longer exists. |
| `desktop-provider-delete-confirm.png` | **Retention and disposal (§10.5).** The staff action, spelled out before it is taken: every visit, the chat, the files, the summaries, the Dexcom connection and the contact details, with the name typed to confirm, and the note that what stays is the record of the deletion. |
| `desktop-consent.png` | **Consent before collection.** The four things §2.4 asks the screen to say — what it collects, that it is optional, that a clinician reads it, how to have it deleted — plus the line that this is not consent to treatment. It is also the evidence for risk `R3`: nothing here mentions that the microphone below sends the patient's voice to the browser vendor. |
| `desktop-verify-locked.png` | **Authentication, patient.** Three wrong codes and the code is spent, said in the patient's own words, with a resend rather than a dead end. The footnote is the anti-phishing line: nobody from the office will ever call to ask for it. |
| `desktop-provider-signin.png` | **Authentication, provider.** One field, a 15-minute single-use link to the work mailbox, and "nothing clinical ever goes in the email" — the transmission-security row about the templates, stated on the screen that sends the first one. It is also risk `R6`: this inbox is the entire factor. |
| `desktop-sweetie-degraded.png` | **Emergency mode operation.** The model gateway is unreachable and the check-in continues: the banner says the assistant is unavailable, the scripted questions keep coming, and the page promises what it can still keep. The mic in the composer is the `R3` surface. |
| `desktop-health-degraded.png` | **`GET /api/health` says which dependency is down.** `db: ok`, `storage: ok`, `model: down / circuit_open`. `"detail":"local"` on the storage check is risk `R7` in one word: this server is keeping uploads on its own disk because no bucket is configured. |
