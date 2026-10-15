// Proving a notification really came from SNS (design §8.1, §10.1). Owner: Justin.
//
// `POST /api/notifications/sns` has no session and no shared secret: SNS will not send either. What it does
// send is an RSA signature over a canonical form of the message (lib/snsEvents.ts snsSigningString), made
// with a key whose certificate is published under `sns.<region>.amazonaws.com`. Verifying it is the whole of
// the route's authority, which is why this is a module with a test rather than four lines in a handler.
//
// Three things have to hold, and all three are load-bearing:
//
//   1. the signature verifies against the certificate's public key;
//   2. the certificate came from an SNS host over https (isSnsCertUrl) — the URL arrives *inside* the
//      message, so without this check an attacker signs their own body with their own key and points us at
//      their own certificate, and everything below passes;
//   3. the topic ARN is one the operator configured (the route's own check).
//
// The certificate is fetched over the network and cached by URL: AWS rotates the signing key, so the URL is
// not a constant, but it changes rarely and every message in a burst quotes the same one.

import { createVerify, X509Certificate } from "node:crypto";
import { isSnsCertUrl, snsSigningString, type SnsEnvelope } from "./snsEvents";

export type Verdict = { ok: true } | { ok: false; code: string };

/** How the certificate is fetched. Replaced in tests, which have their own key pair and no network. */
export type CertFetcher = (url: string) => Promise<string>;

/** SignatureVersion 1 is SHA1, 2 is SHA256. SNS still defaults to 1 on topics created years ago; 2 is what a
 *  topic created today should be set to, and both are accepted because the operator chooses, not us. */
const DIGESTS: Record<string, string> = { "1": "RSA-SHA1", "2": "RSA-SHA256" };

const CACHE_TTL_MS = 6 * 3_600_000;
const certCache = new Map<string, { pem: string; at: number }>();

/** Only for tests: the cache is process-wide and a second test must not see the first one's certificate. */
export function clearCertCache(): void {
  certCache.clear();
}

const defaultFetcher: CertFetcher = async (url) => {
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`certificate fetch failed with ${res.status}`);
  return res.text();
};

async function certificateFor(url: string, fetcher: CertFetcher, now: number): Promise<string> {
  const hit = certCache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.pem;
  const pem = await fetcher(url);
  certCache.set(url, { pem, at: now });
  return pem;
}

/**
 * Whether this envelope was signed by SNS. Every refusal is a short constant rather than a message, because
 * it goes to the log as `code` (lib/log.ts) and into a 403 body, and neither should quote a stranger's
 * payload back at them.
 *
 * `maxAgeMs` is a replay window: a correctly signed notification is still a notification somebody could have
 * kept and posted again a week later, and the only thing in the signed material that moves is `Timestamp`.
 * An hour is far longer than SNS's own retries need and short enough that a captured message goes stale.
 */
export async function verifySnsSignature(
  envelope: SnsEnvelope,
  deps: { fetchCert?: CertFetcher; now?: Date; maxAgeMs?: number } = {},
): Promise<Verdict> {
  const now = deps.now ?? new Date();
  const maxAgeMs = deps.maxAgeMs ?? 3_600_000;

  const digest = DIGESTS[envelope.signatureVersion];
  if (!digest) return { ok: false, code: "unsupported_signature_version" };
  if (!isSnsCertUrl(envelope.signingCertUrl)) return { ok: false, code: "untrusted_cert_url" };

  const signedAt = new Date(envelope.timestamp);
  if (Number.isNaN(signedAt.getTime())) return { ok: false, code: "bad_timestamp" };
  // Both directions: a timestamp in the future is as much a sign of a forged message as a stale one.
  if (Math.abs(now.getTime() - signedAt.getTime()) > maxAgeMs) return { ok: false, code: "stale_timestamp" };

  let publicKey;
  try {
    const pem = await certificateFor(envelope.signingCertUrl, deps.fetchCert ?? defaultFetcher, now.getTime());
    publicKey = new X509Certificate(pem).publicKey;
  } catch {
    return { ok: false, code: "cert_unavailable" };
  }

  let verified = false;
  try {
    const verifier = createVerify(digest);
    verifier.update(snsSigningString(envelope), "utf8");
    verified = verifier.verify(publicKey, envelope.signature, "base64");
  } catch {
    // A `Signature` that is not base64, or a certificate that is not RSA: a bad signature, not a server error.
    return { ok: false, code: "bad_signature" };
  }
  return verified ? { ok: true } : { ok: false, code: "bad_signature" };
}
