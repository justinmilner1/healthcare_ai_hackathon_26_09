import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { setLogSink } from "./log";
import { deleteObjects, deletePrefix, getObjectText, localRoot, newUploadKey, putObject, storageBackend } from "./storage";

const utf8 = (s: string) => new TextEncoder().encode(s);
const ENV = ["STORAGE_BACKEND", "UPLOADS_BUCKET", "UPLOADS_DIR", "UPLOADS_REGION", "UPLOADS_KMS_KEY_ID"];
const saved: Record<string, string | undefined> = {};

/** The backend is read from the environment on every call, so each test sets the whole of it. */
function env(vars: Record<string, string | undefined> = {}) {
  for (const key of ENV) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  // The adapter logs one line per object; a unit test is not where those belong.
  setLogSink(() => {});
});

afterEach(() => {
  env();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  setLogSink();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "sweetspot-uploads-"));
  env({ STORAGE_BACKEND: "local", UPLOADS_DIR: dir });
  return dir;
}

test("the backend is local until a bucket is configured, and STORAGE_BACKEND wins either way", () => {
  env({});
  assert.equal(storageBackend(), "local", "development and CI store on disk");
  env({ UPLOADS_BUCKET: "sweetspot-uploads-staging" });
  assert.equal(storageBackend(), "s3", "a configured bucket is what makes an environment deployed");
  env({ UPLOADS_BUCKET: "sweetspot-uploads-staging", STORAGE_BACKEND: "local" });
  assert.equal(storageBackend(), "local");
  env({ STORAGE_BACKEND: "s3" });
  assert.equal(storageBackend(), "s3");
  env({ STORAGE_BACKEND: "nonsense", UPLOADS_BUCKET: "" });
  assert.equal(storageBackend(), "local", "an unknown name is not a backend");
});

test("local files land under UPLOADS_DIR, which defaults inside data/", () => {
  env({});
  assert.equal(localRoot(), join(process.cwd(), "data", "uploads"), ".gitignore already keeps data/ out of the repo");
  env({ UPLOADS_DIR: "/var/tmp/uploads" });
  assert.equal(localRoot(), "/var/tmp/uploads");
});

test("a key names the visit and the kind, carries no patient data, and never repeats", () => {
  const key = newUploadKey("cm2visitid0000000000000000", "dexcom", "csv");
  assert.match(key, /^visits\/cm2visitid0000000000000000\/dexcom\/[0-9a-f-]{36}\.csv$/);
  assert.equal(newUploadKey("v1", "timeline", "json").endsWith(".json"), true);
  const many = new Set(Array.from({ length: 50 }, () => newUploadKey("v1", "whoop", "csv")));
  assert.equal(many.size, 50, "two uploads of one kind on one visit must not collide");
  // Nothing in the key but ids the database already holds: no filename, no name, no token.
  assert.match(newUploadKey("v1", "dexcom", "csv"), /^[a-z0-9/.-]+$/, "lowercase ids and the kind, nothing a person typed");
});

test("the local backend stores, reads back, and deletes", async () => {
  const dir = scratch();
  const key = newUploadKey("visit-1", "dexcom", "csv");
  const body = "Timestamp,Glucose\n2026-10-01T08:00:00,118\n";

  await putObject(key, utf8(body), "text/csv; charset=utf-8");
  assert.equal(readFileSync(join(dir, key), "utf8"), body, "the bytes on disk are the bytes that came in");
  assert.equal(await getObjectText(key), body);

  assert.deepEqual(await deleteObjects([key]), { deleted: 1, failed: 0 });
  await assert.rejects(() => getObjectText(key), /ENOENT/);
  // Deleting again is a success: the row is already gone, so a retry must not fail on a key that went first.
  assert.deepEqual(await deleteObjects([key]), { deleted: 1, failed: 0 });
  assert.deepEqual(await deleteObjects([]), { deleted: 0, failed: 0 });
});

test("one visit's uploads sit under one prefix, which is what deletion walks", async () => {
  const dir = scratch();
  const keys = [newUploadKey("visit-a", "dexcom", "csv"), newUploadKey("visit-a", "whoop", "csv"), newUploadKey("visit-b", "timeline", "json")];
  for (const key of keys) await putObject(key, utf8("x"), "text/csv");

  assert.deepEqual((await readdir(join(dir, "visits"))).sort(), ["visit-a", "visit-b"]);
  assert.deepEqual((await readdir(join(dir, "visits", "visit-a"))).sort(), ["dexcom", "whoop"]);

  assert.deepEqual(await deleteObjects(keys.slice(0, 2)), { deleted: 2, failed: 0 });
  assert.equal(await getObjectText(keys[2]), "x", "the other visit is untouched");
});

test("a key that this app did not mint is refused, so no write escapes the uploads directory", async () => {
  scratch();
  for (const bad of ["../escaped.csv", "visits/../../etc/passwd", "/etc/passwd", "visits//double.csv", "visits/a/b/c\0.csv", ""]) {
    await assert.rejects(() => putObject(bad, utf8("x"), "text/csv"), /unsafe storage key|escapes the uploads directory/, bad);
    await assert.rejects(() => getObjectText(bad), /unsafe storage key|escapes the uploads directory/, bad);
  }
  // Delete reports the failure rather than throwing: it runs after the database row is already gone.
  assert.deepEqual(await deleteObjects(["../escaped.csv"]), { deleted: 0, failed: 1 });
});

// ---------------------------------------------------------------------------------------------
// Deleting a whole visit's bytes (T14, design §10.4, §10.5).

test("a prefix delete takes one visit's objects and nothing of the visit beside it", async () => {
  scratch();
  const mine = [newUploadKey("visit-a", "dexcom", "csv"), newUploadKey("visit-a", "whoop", "csv")];
  const theirs = newUploadKey("visit-b", "timeline", "json");
  for (const key of [...mine, theirs]) await putObject(key, utf8("x"), "text/csv");

  assert.deepEqual(await deletePrefix("visits/visit-a/"), { deleted: 2, failed: 0 });
  for (const key of mine) await assert.rejects(() => getObjectText(key), /ENOENT/);
  assert.equal(await getObjectText(theirs), "x");
});

test("a prefix delete finds an object no row points at any more, which is why deletion uses one", async () => {
  // The case §10.5 is written for: a first attempt removed the Upload rows and died before the bytes, so
  // nothing in the database can name the key. The prefix still can.
  const dir = scratch();
  const orphan = newUploadKey("visit-c", "dexcom", "csv");
  await putObject(orphan, utf8("x"), "text/csv");
  assert.deepEqual(await deletePrefix("visits/visit-c/"), { deleted: 1, failed: 0 });
  await assert.rejects(() => readdir(join(dir, "visits", "visit-c")), /ENOENT/, "the visit's folder goes with its files");
});

test("deleting a prefix twice is a success, so the patient.delete job is safe to retry", async () => {
  scratch();
  await putObject(newUploadKey("visit-d", "dexcom", "csv"), utf8("x"), "text/csv");
  assert.deepEqual(await deletePrefix("visits/visit-d/"), { deleted: 1, failed: 0 });
  assert.deepEqual(await deletePrefix("visits/visit-d/"), { deleted: 0, failed: 0 }, "nothing there is what was asked for");
  assert.deepEqual(await deletePrefix("visits/never-existed/"), { deleted: 0, failed: 0 });
});

test("a prefix has to end at a path boundary, or one visit's deletion would take its neighbour's", async () => {
  scratch();
  const neighbour = newUploadKey("visit-e2", "dexcom", "csv");
  await putObject(neighbour, utf8("x"), "text/csv");
  // "visits/visit-e" is a prefix of "visits/visit-e2" as a string, and must not be accepted as one as a path.
  await assert.rejects(() => deletePrefix("visits/visit-e"), /path boundary/);
  for (const bad of ["../", "visits/../../", "/etc/", "visits//a/"]) {
    await assert.rejects(() => deletePrefix(bad), /unsafe storage key|path boundary|escapes the uploads directory/, bad);
  }
  assert.equal(await getObjectText(neighbour), "x");
});

test("the S3 backend says which variable is missing instead of calling AWS", async () => {
  env({ STORAGE_BACKEND: "s3" });
  await assert.rejects(() => putObject(newUploadKey("v1", "dexcom", "csv"), utf8("x"), "text/csv"), /UPLOADS_BUCKET must be set/);
  await assert.rejects(() => deletePrefix("visits/v1/"), /UPLOADS_BUCKET must be set/);
});
