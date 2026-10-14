-- T11 / design §3.3, §9.1: raw uploaded files live in object storage, not in the database. The bytes now go
-- to S3 (private bucket, server-side encryption) in deployed environments and to the filesystem in
-- development and CI; `Upload.s3Key` is the only pointer the database keeps, beside `bytes` and `parsedRows`.
--
-- `UploadData.raw` therefore goes. The column held a copy of the file nothing ever read back: every page and
-- every parser reads `UploadData.parsed`. No environment is deployed yet (§13 is still T29/T30), so there is
-- no file here worth migrating out of Postgres first; a row that predates this migration keeps its parsed
-- rows and has no `s3Key`, which the code already treats as "no raw bytes stored".

ALTER TABLE "UploadData" DROP COLUMN "raw";
