import assert from "node:assert/strict";
import test from "node:test";
import { CSRF_COOKIE, CSRF_HEADER, checkCsrf, isStateChanging, newCsrfToken, type CsrfInput } from "./csrf";

const TOKEN = newCsrfToken();

/** A request as middleware sees it on our own dashboard: same origin, cookie echoed in the header. */
const good = (over: Partial<CsrfInput> = {}): CsrfInput => ({
  method: "POST",
  origin: "https://sweetspot.health",
  referer: null,
  host: "sweetspot.health",
  headerToken: TOKEN,
  cookieToken: TOKEN,
  ...over,
});

test("a token is base64url and long enough to be unguessable", () => {
  const token = newCsrfToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newCsrfToken());
});

test("only unsafe methods are checked", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(isStateChanging(method), false, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) assert.equal(isStateChanging(method), true, method);
});

test("a safe method passes with nothing at all", () => {
  assert.equal(checkCsrf({ method: "GET", origin: null, referer: null, host: null, headerToken: null, cookieToken: null }), null);
});

test("a same-origin post that echoes the cookie passes", () => {
  assert.equal(checkCsrf(good()), null);
});

test("a cross-site post is refused even when it somehow guessed the token", () => {
  const reason = checkCsrf(good({ origin: "https://evil.example" }));
  assert.equal(reason, "origin does not match host");
});

test("the proxy's view of the host is what the origin is compared against", () => {
  // Behind an ALB, Host is the internal name and x-forwarded-host is what the browser asked for.
  assert.equal(checkCsrf(good({ host: "10.0.3.17:3000", forwardedHost: "sweetspot.health" })), null);
});

test("Referer stands in when there is no Origin", () => {
  assert.equal(checkCsrf(good({ origin: null, referer: "https://sweetspot.health/provider/abc" })), null);
  assert.equal(checkCsrf(good({ origin: null, referer: "https://evil.example/page" })), "origin does not match host");
});

test("an unparsable origin is refused rather than ignored", () => {
  assert.equal(checkCsrf(good({ origin: "not a url" })), "unparsable origin");
});

test("a matching origin is not enough on its own: the token is still required", () => {
  // A same-origin injection, or any caller that can reach the API, still has to have read the cookie.
  assert.equal(checkCsrf(good({ headerToken: null })), `no ${CSRF_HEADER} header`);
  assert.equal(checkCsrf(good({ cookieToken: null })), `no ${CSRF_COOKIE} cookie`);
});

test("a header that does not match the cookie is refused", () => {
  assert.equal(checkCsrf(good({ headerToken: newCsrfToken() })), `${CSRF_HEADER} does not match the ${CSRF_COOKIE} cookie`);
});

test("a token of the wrong shape cannot match itself", () => {
  // Without the shape check, `ss_csrf=x` plus `x-csrf-token: x` would be a valid pair.
  assert.equal(checkCsrf(good({ headerToken: "x", cookieToken: "x" })), "malformed csrf token");
});

test("a no-Origin client (curl, the e2e request fixture) passes on the token alone", () => {
  assert.equal(checkCsrf(good({ origin: null, referer: null })), null);
  assert.equal(checkCsrf(good({ origin: null, referer: null, headerToken: null })), `no ${CSRF_HEADER} header`);
});

test("the query-string token is accepted where a header cannot be set", () => {
  // The sandbox Dexcom button is a plain <form method="POST">; see CSRF_PARAM in ./csrf.
  assert.equal(checkCsrf(good({ headerToken: null, urlToken: TOKEN })), null);
  assert.equal(checkCsrf(good({ headerToken: null, urlToken: newCsrfToken() })), `${CSRF_HEADER} does not match the ${CSRF_COOKIE} cookie`);
});
