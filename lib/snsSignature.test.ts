// Unit tests for the one thing standing between `POST /api/notifications/sns` and anybody on the internet.
//
// The test is a real signature check, not a stubbed one: it generates an RSA key pair, writes a self-signed
// certificate with `openssl`, and signs the same canonical string SNS would (lib/snsEvents.ts). The fetcher
// is injected, which is what makes that possible offline — and the test that matters most is the one where
// the *certificate* is the attacker's: a message signed perfectly with a key whose certificate is served from
// a host that is not AWS must be refused, because otherwise the signature proves nothing at all.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseSnsEnvelope, snsSigningString, type SnsEnvelope } from "./snsEvents";
import { clearCertCache, verifySnsSignature } from "./snsSignature";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:sweetspot-ses-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
const NOW = new Date("2026-10-15T09:00:00.000Z");

/** `openssl req -x509` is how a certificate gets made; node:crypto signs but does not issue. */
function selfSigned(): { privateKey: string; certificate: string } | null {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
  try {
    const keyFile = join(dir, "key.pem");
    writeFileSync(keyFile, pem, "utf8");
    const certificate = execFileSync(
      "openssl",
      ["req", "-x509", "-key", keyFile, "-subj", "/CN=sns.us-east-1.amazonaws.com", "-days", "1", "-sha256"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { privateKey: pem, certificate };
  } catch {
    // No openssl on this machine: there is nothing to verify against, so the suite says so and moves on
    // rather than passing on a check it did not make.
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const keys = selfSigned();

describe("verifySnsSignature", { skip: keys ? false : "openssl is not available to issue a test certificate" }, () => {
  const { privateKey, certificate } = keys!;
  /** How many times the injected fetcher was asked, so the cache can be asserted. */
  let fetches: string[];
  const fetchCert = async (url: string) => {
    fetches.push(url);
    return certificate;
  };

  const signed = (over: Record<string, unknown> = {}, digest = "RSA-SHA256"): SnsEnvelope => {
    const envelope = parseSnsEnvelope({
      Type: "Notification",
      MessageId: "22b480bf-3f2b-5b0c-a0a1-9d4f1f8d0b3a",
      TopicArn: TOPIC,
      Message: '{"notificationType":"Bounce"}',
      Timestamp: NOW.toISOString(),
      SignatureVersion: digest === "RSA-SHA256" ? "2" : "1",
      Signature: "placeholder",
      SigningCertURL: CERT_URL,
      ...over,
    })!;
    const signer = createSign(digest);
    signer.update(snsSigningString(envelope), "utf8");
    return { ...envelope, signature: signer.sign(privateKey, "base64") };
  };

  before(() => clearCertCache());
  beforeEach(() => {
    fetches = [];
    clearCertCache();
  });
  after(() => clearCertCache());

  it("accepts a message SNS really signed, at both signature versions", async () => {
    assert.deepEqual(await verifySnsSignature(signed(), { fetchCert, now: NOW }), { ok: true });
    assert.deepEqual(await verifySnsSignature(signed({}, "RSA-SHA1"), { fetchCert, now: NOW }), { ok: true });
  });

  it("refuses a message whose body was changed after it was signed", async () => {
    const tampered = { ...signed(), message: '{"notificationType":"Complaint"}' };
    assert.deepEqual(await verifySnsSignature(tampered, { fetchCert, now: NOW }), { ok: false, code: "bad_signature" });
  });

  it("refuses a signature made with a different key, however well formed", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const envelope = signed();
    const signer = createSign("RSA-SHA256");
    signer.update(snsSigningString(envelope), "utf8");
    const forged = { ...envelope, signature: signer.sign(other, "base64") };
    assert.deepEqual(await verifySnsSignature(forged, { fetchCert, now: NOW }), { ok: false, code: "bad_signature" });
  });

  it("refuses a certificate URL that is not AWS's, before fetching it", async () => {
    // The whole attack: sign your own message with your own key and point us at your own certificate.
    const verdict = await verifySnsSignature({ ...signed(), signingCertUrl: "https://evil.test/cert.pem" }, { fetchCert, now: NOW });
    assert.deepEqual(verdict, { ok: false, code: "untrusted_cert_url" });
    assert.deepEqual(fetches, [], "nothing should have been fetched from it");
  });

  it("refuses a replay: a correctly signed notification kept and posted later", async () => {
    const envelope = signed();
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    assert.deepEqual(await verifySnsSignature(envelope, { fetchCert, now: later }), { ok: false, code: "stale_timestamp" });
    // And the same window in the other direction, which is just as much a sign of a forgery.
    const ahead = new Date(NOW.getTime() - 2 * 3_600_000);
    assert.deepEqual(await verifySnsSignature(envelope, { fetchCert, now: ahead }), { ok: false, code: "stale_timestamp" });
    assert.deepEqual(await verifySnsSignature(envelope, { fetchCert, now: new Date(NOW.getTime() + 60_000) }), { ok: true });
  });

  it("refuses a signature version it does not know, rather than guessing a digest", async () => {
    const verdict = await verifySnsSignature({ ...signed(), signatureVersion: "9" }, { fetchCert, now: NOW });
    assert.deepEqual(verdict, { ok: false, code: "unsupported_signature_version" });
  });

  it("refuses an unparsable timestamp", async () => {
    const verdict = await verifySnsSignature({ ...signed(), timestamp: "whenever" }, { fetchCert, now: NOW });
    assert.deepEqual(verdict, { ok: false, code: "bad_timestamp" });
  });

  it("reports a certificate it could not fetch as a refusal, not a crash", async () => {
    const verdict = await verifySnsSignature(signed(), {
      fetchCert: async () => {
        throw new Error("network is down");
      },
      now: NOW,
    });
    assert.deepEqual(verdict, { ok: false, code: "cert_unavailable" });
  });

  it("refuses a signature that is not even base64", async () => {
    const verdict = await verifySnsSignature({ ...signed(), signature: "!!!not base64!!!" }, { fetchCert, now: NOW });
    assert.equal(verdict.ok, false);
  });

  it("fetches the certificate once for a burst from the same URL", async () => {
    await verifySnsSignature(signed(), { fetchCert, now: NOW });
    await verifySnsSignature(signed({ MessageId: "another-id" }), { fetchCert, now: NOW });
    assert.deepEqual(fetches, [CERT_URL]);
  });
});
