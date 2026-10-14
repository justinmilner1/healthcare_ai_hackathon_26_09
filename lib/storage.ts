// Raw uploaded files (design §3.3, §9.1). Owner: platform.
//
// Two backends behind one interface, picked from the environment the same way email and SMS pick theirs:
//   s3     when UPLOADS_BUCKET is set (deployed environments: private bucket, server-side encryption)
//   local  otherwise (development, CI, the e2e suite): files under UPLOADS_DIR, default data/uploads/
//
// The bytes never go in the database; the database keeps the parsed rows and `Upload.s3Key` (§3.3, §4.6).
// The route is a server-side relay rather than a presigned PUT from the browser: §9.1 parses and type-sniffs
// on the server before anything is stored, which means the server has the bytes in hand anyway, and no key
// or bucket name ever reaches a browser.
//
// Keys carry no patient data — `visits/<visitId>/<kind>/<uuid>.<ext>` — so one patient's key says nothing
// about them and nothing about anyone else. The filename the patient chose stays in `Upload.filename`.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { log } from "./log";
import type { UploadKind } from "./types";

export type StorageBackend = "s3" | "local";

/** `local` unless a bucket is configured. STORAGE_BACKEND forces either, which is how a test pins it. */
export function storageBackend(): StorageBackend {
  const forced = process.env.STORAGE_BACKEND;
  if (forced === "s3" || forced === "local") return forced;
  return process.env.UPLOADS_BUCKET ? "s3" : "local";
}

/** Where the local backend writes. Under data/, which .gitignore already keeps out of the repo. */
export function localRoot(): string {
  return process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads");
}

const EXTENSION: Record<"csv" | "json", string> = { csv: "csv", json: "json" };

/** A fresh key for one upload. Random, so two uploads of the same kind on the same visit never collide. */
export function newUploadKey(visitId: string, kind: UploadKind, format: "csv" | "json"): string {
  return `visits/${visitId}/${kind}/${randomUUID()}.${EXTENSION[format]}`;
}

/** Keys are minted above, so a key that is not in that shape did not come from this app. Reject it rather
 *  than resolve it: on the local backend `../` would otherwise write outside the uploads directory. */
function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`unsafe storage key: ${key.slice(0, 40)}`);
  }
}

function localPath(key: string): string {
  assertSafeKey(key);
  const root = resolve(localRoot());
  const path = resolve(join(root, key));
  // Belt and braces: assertSafeKey already rules this out, and a bug in it should still not escape the root.
  if (path !== root && !path.startsWith(root + sep)) throw new Error("storage key escapes the uploads directory");
  return path;
}

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({ region: process.env.UPLOADS_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1" });
}

function bucket(): string {
  const name = process.env.UPLOADS_BUCKET;
  if (!name) throw new Error("UPLOADS_BUCKET must be set when STORAGE_BACKEND=s3");
  return name;
}

/** Store one file's bytes under `key`. The S3 side asks for SSE and sets no ACL: the bucket is private (§3.3). */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const backend = storageBackend();
  if (backend === "local") {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  } else {
    assertSafeKey(key);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: process.env.UPLOADS_KMS_KEY_ID ? "aws:kms" : "AES256",
        SSEKMSKeyId: process.env.UPLOADS_KMS_KEY_ID,
      }),
    );
  }
  log.info("object_stored", { provider: backend, bytes: body.byteLength });
}

/** Read the bytes back as text. Nothing in a request needs this yet; deletion drills and support do. */
export async function getObjectText(key: string): Promise<string> {
  if (storageBackend() === "local") return readFile(localPath(key), "utf8");
  assertSafeKey(key);
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return (await out.Body?.transformToString("utf-8")) ?? "";
}

/**
 * Delete stored objects, one key at a time, and report what went. Deleting a key that is already gone is a
 * success: callers delete after the database row, so a retry must not fail on the first key.
 */
export async function deleteObjects(keys: string[]): Promise<{ deleted: number; failed: number }> {
  const backend = storageBackend();
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      if (backend === "local") {
        await rm(localPath(key), { force: true });
      } else {
        assertSafeKey(key);
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const client = await s3Client();
        await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      }
      deleted += 1;
    } catch (e) {
      // The row is already gone, so the caller cannot usefully retry inside the request. Leave a line that
      // says one object is orphaned; the retention sweep (§10.4) and patient deletion (§10.5) come back to it.
      failed += 1;
      log.warn("object_delete_failed", { provider: backend, error: e });
    }
  }
  if (deleted) log.info("objects_deleted", { provider: backend, count: deleted });
  return { deleted, failed };
}

/** A prefix has to be a key's worth of path and end at a boundary, or `visits/abc` would also match
 *  `visits/abcdef` — one patient's deletion taking another's bytes with it. */
function assertSafePrefix(prefix: string): void {
  assertSafeKey(prefix.replace(/\/$/, ""));
  if (!prefix.endsWith("/")) throw new Error("a storage prefix must end at a path boundary");
}

/**
 * Delete everything stored under `prefix`, and report how many objects that was.
 *
 * This is the deletion §10.5 needs and `deleteObjects` cannot give it. Deleting by key means knowing the
 * keys, which means reading the `Upload` rows — so an object whose row is already gone (a half-finished
 * earlier attempt, a row removed before T11 ever wrote a key) is invisible and stays for ever. A prefix is
 * the visit itself (`visits/<visitId>/`, lib/storage.ts newUploadKey), so it removes what the database can no
 * longer point at, and running it twice is a no-op rather than an error. Idempotent, which is what makes the
 * `patient.delete` job safe to retry.
 */
export async function deletePrefix(prefix: string): Promise<{ deleted: number; failed: number }> {
  assertSafePrefix(prefix);
  const backend = storageBackend();
  if (backend === "local") {
    const dir = localPath(prefix.replace(/\/$/, ""));
    let deleted = 0;
    try {
      // Counted before the removal, because afterwards there is nothing left to count.
      deleted = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      // A prefix with nothing under it is a success: the caller is asking for it to be gone, and it is.
      if ((e as { code?: string }).code === "ENOENT") return { deleted: 0, failed: 0 };
      log.warn("objects_delete_failed", { provider: backend, error: e });
      return { deleted: 0, failed: 1 };
    }
    if (deleted) log.info("objects_deleted", { provider: backend, count: deleted });
    return { deleted, failed: 0 };
  }

  const { DeleteObjectsCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  let deleted = 0;
  let failed = 0;
  let token: string | undefined;
  do {
    // One page at a time: DeleteObjects takes a thousand keys, which is also the listing's page size.
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (keys.length === 0) continue;
    const out = await client.send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
    failed += out.Errors?.length ?? 0;
    deleted += keys.length - (out.Errors?.length ?? 0);
  } while (token);
  if (failed) log.warn("objects_delete_failed", { provider: backend, count: failed });
  if (deleted) log.info("objects_deleted", { provider: backend, count: deleted });
  return { deleted, failed };
}
