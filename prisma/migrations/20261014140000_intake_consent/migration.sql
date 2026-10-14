-- §2.4 The consent screen in front of the intake. The patient's own acceptance, with the time, lives on the
-- visit: accepting opens the patient pages, declining ends the session (lib/consent.ts, app/api/consent).
-- Nullable with no default, so every visit made before this migration simply has not answered yet and is
-- asked the next time the link is opened.
ALTER TABLE "Visit" ADD COLUMN "intakeConsentAt" TIMESTAMP(3);
ALTER TABLE "Visit" ADD COLUMN "intakeConsentDeclinedAt" TIMESTAMP(3);
