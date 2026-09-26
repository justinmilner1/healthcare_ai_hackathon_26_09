ALTER TABLE "Patient" ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DexcomConnection" (
  "patientId" TEXT NOT NULL PRIMARY KEY,
  "encryptedTokens" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "importedAt" DATETIME,
  CONSTRAINT "DexcomConnection_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DexcomOAuthState" (
  "stateHash" TEXT NOT NULL PRIMARY KEY,
  "browserHash" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  CONSTRAINT "DexcomOAuthState_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
