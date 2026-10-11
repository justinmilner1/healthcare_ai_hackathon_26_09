// CSRF protection on state-changing routes (design §10.8). Owner: compliance.
//
// Why it matters here even without a password login: both of the app's sessions are cookies — the provider
// session (today `ss_provider` from lib/providerSession.ts, Auth.js's own once T05 lands) and the patient's
// visit link. A browser attaches a cookie to any request to this origin, whichever page started it, so a
// page on another site can POST /api/invite or /api/upload in the background and the request arrives
// carrying the clinician's session. Nothing in the route can tell it apart from a click on our own dashboard.
//
// That sentence is also the limit of what this protects, and the exemptions below follow from it. The attack
// needs an *ambient* credential: something the browser supplies on its own. A request whose authority is a
// bearer secret in a header has none, so challenging it buys nothing and costs the caller everything.
//
// The scheme is the cookie-to-header token (double submit). A random token sits in a cookie that is readable
// by our own JavaScript, and every state-changing request must repeat it in the x-csrf-token header. A
// cross-site page can make the browser *send* our cookie but cannot *read* it, so it cannot set the header.
// `samesite=lax` on the cookie is the second lock, and the Origin check below is the third: three cheap,
// independent checks rather than one clever one.
//
// This module is imported by middleware.ts (edge runtime) and by client components, so it stays on Web
// APIs only: no node:crypto, no next/server. checkCsrf takes plain values so it can be unit-tested without
// a request object.

export const CSRF_COOKIE = "ss_csrf";
export const CSRF_HEADER = "x-csrf-token";
/** The same token in the query string, for the one caller that cannot set a header: see checkCsrf. */
export const CSRF_PARAM = "csrf";

/** 30 days, the same as the provider cookie: long enough that a tab left open overnight still posts. */
export const CSRF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** The header Next.js puts on a Server Action POST. Its presence is what tells one apart from a form post. */
export const SERVER_ACTION_HEADER = "next-action";

/**
 * Routes that derive no authority from a cookie, and so have nothing for a cross-site page to ride.
 *
 * `/api/jobs/run` is the §3.4 runner. EventBridge Scheduler calls it once a minute with
 * `Authorization: Bearer <JOBS_SECRET>` and nothing else, and `authorizeRunner` refuses it without that
 * secret (401, or 503 where none is configured). A cross-site page can make a browser send our cookies; it
 * cannot make it send that header, and the route does nothing for a caller who lacks it. Challenging it for
 * a CSRF token therefore protects nothing and breaks the queue: middleware would answer 403 before the
 * handler ran, so no invite, no summary email, no retention sweep would ever be sent.
 *
 * The bar for adding a path here: the route must grant nothing on the strength of a cookie. If a route reads
 * a session, it is not exempt, whatever else it also checks.
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = ["/api/jobs/run"];

export function isCsrfExemptPath(pathname: string): boolean {
  // Exact match only. A prefix match would exempt /api/jobs/runner-admin the day someone adds it.
  return CSRF_EXEMPT_PATHS.includes(pathname.replace(/\/+$/, "") || "/");
}

/** Methods that cannot change state, per RFC 9110. Everything else is checked. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** 32 random bytes, base64url: URL-safe, cookie-safe, no escaping anywhere. */
export function newCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-independent, branch-free compare. The token is not a secret worth a lab timing attack, but a
 *  plain `===` on a secret is the kind of thing a reviewer should never have to think about. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A token we would have minted: base64url, long enough to be unguessable. Keeps a one-character cookie
 *  someone set by hand from counting as a match against itself. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export type CsrfInput = {
  method: string;
  /** The request path, for the machine-to-machine exemption in CSRF_EXEMPT_PATHS. */
  pathname: string;
  /** The browser's Origin header, absent on same-origin GETs and on non-browser clients. */
  origin: string | null;
  /** Fallback when Origin is absent but a Referer is not: older browsers on form posts. */
  referer: string | null;
  /** Host as the client addressed it, and the proxy's view of it when there is one in front. */
  host: string | null;
  forwardedHost?: string | null;
  /** Next's `Next-Action` header, set on a Server Action POST and on nothing else. */
  serverAction?: string | null;
  headerToken: string | null;
  /** `?csrf=` on the request URL. A plain <form method="POST"> sets no headers, and reading the token out
   *  of the body is not an option in middleware: consuming the stream there leaves the route handler with
   *  an empty body, which would break every multipart upload. The query string is the one part of the
   *  request middleware can read for free. It is as unguessable to another origin as the header is, and
   *  Referrer-Policy: no-referrer (lib/security.ts) keeps the URL from travelling anywhere. */
  urlToken?: string | null;
  cookieToken: string | null;
};

/**
 * The reason to refuse a request, or null to let it through. A reason string, not a boolean, because it is
 * the one thing worth logging: a 403 with no explanation is a bug report nobody can act on. It names a
 * header, never a token value.
 */
export function checkCsrf(input: CsrfInput): string | null {
  if (!isStateChanging(input.method)) return null;

  // 1. Origin, when the browser sent one. A cross-site post cannot forge it. This runs for every request,
  //    exempt path or not: it costs nothing and it is the check that does not depend on our own cookie.
  const expected = (input.forwardedHost || input.host || "").toLowerCase();
  const stated = input.origin ?? input.referer;
  let originVerified = false;
  if (stated) {
    let statedHost: string;
    try {
      statedHost = new URL(stated).host.toLowerCase();
    } catch {
      return "unparsable origin";
    }
    if (!expected) return "no host to compare the origin against";
    if (statedHost !== expected) return "origin does not match host";
    originVerified = true;
  }

  // 2. Two kinds of request have no ambient credential for the token to protect, so the token is not asked
  //    of them. Both are narrow, and neither can be reached by a cross-site page: a `<form>` cannot set a
  //    request header at all, and a cross-origin fetch that sets one needs a CORS preflight this app never
  //    answers.
  //
  //    a. A route in CSRF_EXEMPT_PATHS — authority is a bearer secret the route checks itself, never a
  //       cookie. See the list for the bar a path has to clear.
  if (isCsrfExemptPath(input.pathname)) return null;

  //    b. A Next.js Server Action. No application code issues the request, so there is nowhere to stamp a
  //       header: Next posts it to the page's own URL with `Next-Action` and whatever cookies the browser
  //       has. Next runs its own Origin-against-Host check on these before invoking the action, and so does
  //       step 1 above — which is why this only stands down when step 1 actually verified something. A
  //       Server Action POST from a browser always carries an Origin, so requiring it costs nothing real.
  if (input.serverAction && originVerified) return null;

  // 3. The double-submit token. Required even when the Origin matched: a same-origin injection, or a
  //    client that sends no Origin at all, is exactly what the token is for.
  const { cookieToken } = input;
  const sent = input.headerToken ?? input.urlToken ?? null;
  if (!cookieToken) return `no ${CSRF_COOKIE} cookie`;
  if (!sent) return `no ${CSRF_HEADER} header`;
  if (!TOKEN_SHAPE.test(cookieToken) || !TOKEN_SHAPE.test(sent)) return "malformed csrf token";
  if (!constantTimeEqual(sent, cookieToken)) return `${CSRF_HEADER} does not match the ${CSRF_COOKIE} cookie`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Client side. Everything below runs in the browser.

/** The token in document.cookie, or null. */
export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return TOKEN_SHAPE.test(value) ? value : null;
}

/** The token to send, minting and storing one if the cookie is missing. Middleware sets the cookie on every
 *  document response, so this normally just reads it; minting covers the page that was restored from a cache
 *  older than the cookie. Either way the value in the cookie and the value in the header are the same, which
 *  is all the scheme asks. */
export function ensureCsrfToken(): string {
  const existing = readCsrfToken();
  if (existing) return existing;
  const token = newCsrfToken();
  if (typeof document !== "undefined") {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${CSRF_COOKIE}=${token}; path=/; max-age=${CSRF_COOKIE_MAX_AGE}; samesite=lax${secure}`;
  }
  return token;
}

/**
 * fetch() with the CSRF header attached. Every client call that changes something goes through this; a
 * plain fetch() with a POST gets a 403 from middleware, which is the point — the failure is loud and local
 * rather than a hole nobody notices.
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!isStateChanging(method)) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, ensureCsrfToken());
  return fetch(input, { ...init, headers });
}
