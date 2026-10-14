import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy, newNonce, STATIC_SECURITY_HEADERS } from "./security";

const header = (key: string) => STATIC_SECURITY_HEADERS.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

/** The directives of one policy, as a map, so a test can assert on one without string matching. */
const directives = (csp: string): Record<string, string> =>
  Object.fromEntries(
    csp.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );

test("the headers design §10.8 names are all there", () => {
  assert.match(String(header("Strict-Transport-Security")), /max-age=\d{7,}/);
  assert.equal(header("X-Frame-Options"), "DENY");
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  // A visit link is a bearer token in the URL: it must not travel in a Referer header.
  assert.equal(header("Referrer-Policy"), "no-referrer");
});

test("HSTS covers subdomains and is preload-eligible", () => {
  const hsts = String(header("Strict-Transport-Security"));
  assert.match(hsts, /includeSubDomains/);
  assert.match(hsts, /preload/);
});

test("no header is listed twice", () => {
  const keys = STATIC_SECURITY_HEADERS.map((h) => h.key.toLowerCase());
  assert.deepEqual(keys, [...new Set(keys)]);
});

test("the static list does not carry a CSP: middleware owns that one", () => {
  // Two Content-Security-Policy headers on one response are enforced as the intersection of both, which is
  // how a page that works locally goes blank in production.
  assert.equal(header("Content-Security-Policy"), undefined);
});

test("the microphone is the only permission left on, and only for us", () => {
  const policy = String(header("Permissions-Policy"));
  assert.match(policy, /microphone=\(self\)/);
  for (const feature of ["camera", "geolocation", "payment", "usb"]) {
    assert.match(policy, new RegExp(`${feature}=\\(\\)`), feature);
  }
});

test("a nonce is random per call", () => {
  assert.notEqual(newNonce(), newNonce());
  assert.match(newNonce(), /^[A-Za-z0-9+/]{20,}={0,2}$/);
});

test("the policy carries this response's nonce and strict-dynamic", () => {
  const nonce = newNonce();
  const d = directives(contentSecurityPolicy(nonce));
  assert.match(d["script-src"], new RegExp(`'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
  assert.match(d["script-src"], /'strict-dynamic'/);
});

test("a built policy blocks the things that make XSS and clickjacking work", () => {
  const d = directives(contentSecurityPolicy(newNonce()));
  assert.equal(d["default-src"], "'self'");
  assert.equal(d["object-src"], "'none'");
  assert.equal(d["frame-ancestors"], "'none'");
  assert.equal(d["base-uri"], "'self'");
  assert.equal(d["form-action"], "'self'");
  assert.doesNotMatch(d["script-src"], /'unsafe-inline'|'unsafe-eval'/);
});

test("a form may post to us, and be redirected on only to an origin we named", () => {
  // The Dexcom sandbox button posts to /api/dexcom/connect and is 303'd on to Dexcom. Firefox checks the
  // redirect against form-action; Chrome does not. Listing it keeps both working.
  assert.equal(directives(contentSecurityPolicy(newNonce()))["form-action"], "'self'");
  const withDexcom = directives(contentSecurityPolicy(newNonce(), { formAction: ["https://sandbox-api.dexcom.com"] }));
  assert.equal(withDexcom["form-action"], "'self' https://sandbox-api.dexcom.com");
});

test("a production policy upgrades plain HTTP subresources; dev does not", () => {
  assert.match(contentSecurityPolicy(newNonce()), /upgrade-insecure-requests/);
  assert.doesNotMatch(contentSecurityPolicy(newNonce(), { dev: true }), /upgrade-insecure-requests/);
});

test("only the dev policy allows what `next dev` needs", () => {
  // next dev evaluates its HMR runtime and talks to itself over a websocket. A build does neither, and the
  // e2e suite and every deployed environment run a build.
  const dev = directives(contentSecurityPolicy(newNonce(), { dev: true }));
  assert.match(dev["script-src"], /'unsafe-eval'/);
  assert.match(dev["connect-src"], /ws:/);
  const prod = directives(contentSecurityPolicy(newNonce()));
  assert.doesNotMatch(prod["script-src"], /'unsafe-eval'/);
  assert.equal(prod["connect-src"], "'self'");
});
