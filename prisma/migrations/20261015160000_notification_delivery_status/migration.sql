-- T19 / design §8.1, §8.3: what a notification provider told us after the send.
--
-- Two halves. On `Patient`, the standing facts a provider reported about a channel: an SES bounce or
-- complaint makes an address undeliverable, and the patient texting STOP stops the texts. lib/suppression.ts
-- is the rule that reads these, lib/notifyStore.ts the code that writes them, and both are nullable because
-- the normal state of a patient is that nothing has gone wrong.
--
-- On `VisitDelivery`, room for the messages §8.2 sends that the first version of the table could not hold.
-- The key was (visitId, channel), which is one row per channel for the whole visit: the summary notice then
-- overwrote the invite's row, and the summary's two emails — one to the clinician, one to the patient —
-- overwrote each other. Keying on the message kind and the audience as well keeps each of §8.2's five
-- templates its own answer to "did this reach them". Existing rows are invites to the patient, which is
-- what the default says.
ALTER TABLE "Patient" ADD COLUMN "emailUndeliverableAt" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN "emailUndeliverableReason" TEXT;
ALTER TABLE "Patient" ADD COLUMN "smsOptOutAt" TIMESTAMP(3);

ALTER TABLE "VisitDelivery" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'patient';

DROP INDEX "VisitDelivery_visitId_channel_key";
CREATE UNIQUE INDEX "VisitDelivery_visitId_kind_channel_audience_key" ON "VisitDelivery"("visitId", "kind", "channel", "audience");
-- A bounce arrives quoting SES's own message id and nothing else, so that is how the row is found (§8.3).
CREATE INDEX "VisitDelivery_providerMessageId_idx" ON "VisitDelivery"("providerMessageId");
