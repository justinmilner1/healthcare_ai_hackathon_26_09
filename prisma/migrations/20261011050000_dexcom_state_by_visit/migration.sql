-- T03 / design §4.4: the one-use Dexcom OAuth state is bound to the visit the patient started from, not to
-- the patient. It was the last place a route had to guess which visit was meant ("the patient's newest
-- visit"), which is the hackathon's one-visit-per-patient assumption. The Dexcom *connection* is untouched
-- and stays per patient (§4.10).
--
-- Rows here are single use and expire after ten minutes, so an authorization in flight during a deploy is
-- dropped rather than carried over: the patient presses Connect again.

DELETE FROM "DexcomOAuthState";

ALTER TABLE "DexcomOAuthState" DROP CONSTRAINT "DexcomOAuthState_patientId_fkey";
ALTER TABLE "DexcomOAuthState" DROP COLUMN "patientId";
ALTER TABLE "DexcomOAuthState" ADD COLUMN "visitId" TEXT NOT NULL;

ALTER TABLE "DexcomOAuthState" ADD CONSTRAINT "DexcomOAuthState_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
