// The one place every request passes through (design §10.8). Owner: compliance.
//
// Four jobs, in order:
//   1. Rate-limit the invite link route, `/s/<token>` (§5.4, lib/ratelimit.ts). Only that route: every other
//      route §5.4 names is an API route that limits itself in its handler, where the token has named a visit.
//      This one has no handler to put it in — it is a page — and middleware is the only thing in front of it.
//   2. Hand out the CSRF cookie, so the page's JavaScript has a token to echo back (lib/csrf.ts).
//   3. Refuse a state-changing request that does not echo it, before it reaches a route handler.
//   4. Set the Content-Security-Policy with this response's nonce (lib/security.ts). The headers that do
//      not change per request come from next.config.ts instead.
//
// Edge runtime: Web APIs only, no node:crypto, no Prisma. Every helper it uses is written for that.

import { NextResponse, type NextRequest } from "next/server";
import { CSRF_COOKIE, CSRF_COOKIE_MAX_AGE, CSRF_HEADER, CSRF_PARAM, SERVER_ACTION_HEADER, checkCsrf, isStateChanging, newCsrfToken } from "@/lib/csrf";
import { clientIp, keyFingerprint, limit, tooManyHeaders, tooManyMessage } from "@/lib/ratelimit";
import { contentSecurityPolicy, newNonce, STATIC_SECURITY_HEADERS } from "@/lib/security";

export const config = {
  // Everything but the static output and the one route that checks itself. A hashed chunk under
  // /_next/static is immutable and public: it needs no nonce, and setting a cookie on it would make every
  // asset response vary. Favicons likewise. `api/upload` is CSRF_SELF_CHECKED_PATHS in lib/csrf.ts: a
  // request that goes through middleware is proxied through the edge runtime, which does not carry a body
  // much over 10 MB, and §9.1 promises uploads up to 20 MB. It runs checkCsrfRequest in the handler instead.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/upload|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2)$).*)"],
};

const isDev = process.env.NODE_ENV !== "production";

/** Where a form in this app may be redirected on to: Dexcom's authorization page, and nothing else. Read
 *  from the same variable lib/dexcom.ts validates, and empty when Dexcom is not configured. Next inlines a
 *  statically referenced env var into the middleware bundle, so this is fixed at build time — changing
 *  DEXCOM_BASE_URL means a rebuild, which is already true of the rest of the Dexcom configuration. */
const FORM_ACTION_EXTRA = ((base) => {
  if (!base) return [];
  try {
    return [new URL(base).origin];
  } catch {
    return [];
  }
})(process.env.DEXCOM_BASE_URL);

/** Whether this request arrived over TLS, which is what decides the cookie's Secure flag. Not NODE_ENV: a
 *  production build served over plain HTTP — `next start` locally, and the e2e suite — would then set Secure
 *  on a cookie the browser immediately discards, and every POST from the page would be refused. */
function overTls(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/** The invite link route and everything under it: `/s/<token>` and `/s/<token>/intake`. The token is the
 *  first segment, which is the only reason this limit can be keyed per visit from the edge at all. */
const LINK_ROUTE = /^\/s\/([^/]+)/;

/**
 * §5.4 on the invite link route. Keyed by the caller's address and by the token, which names the visit (§5.3)
 * — middleware cannot reach the database to turn one into a visit id, so a fingerprint of the token stands in
 * for it and the link itself never becomes a key (`keyFingerprint`).
 *
 * Unknown tokens get a window each, which is the point of the per-IP key beside it: an enumeration sweep is
 * a different token every time and only the address holds it still.
 */
function linkRefusal(req: NextRequest): NextResponse | null {
  const token = LINK_ROUTE.exec(req.nextUrl.pathname)?.[1];
  if (!token) return null;
  const byIp = limit("link", "ip", clientIp(req.headers));
  const verdict = byIp.ok ? limit("link", "visit", keyFingerprint(decodeToken(token))) : byIp;
  if (verdict.ok) return null;

  // An HTML page, not JSON: this is a link a patient typed into a browser, so what comes back has to be
  // readable by one. No inline script and no CSP on this response — it sets neither, so there is nothing for
  // the nonce below to be missing from. The static headers are set here for the same reason the CSRF refusal
  // sets them: next.config.ts applies them to responses the router produces, not to one middleware returns.
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", ...tooManyHeaders(verdict) });
  for (const h of STATIC_SECURITY_HEADERS) headers.set(h.key, h.value);
  return new NextResponse(linkPage(tooManyMessage(verdict)), { status: 429, headers });
}

/** The path as the patient's link spells it. A stray `%` makes decodeURIComponent throw, and a middleware
 *  that throws is a 500 on every page under /s — so the raw segment stands in. Either way one link is one
 *  window; the two spellings being two windows matters only to whoever typed the broken one. */
function decodeToken(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The whole page a refused link gets. Plain, self-contained, and it says the one thing worth saying. */
function linkPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Too many requests</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fdf7ef; color: #3c2f23;
       font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
div { max-width: 24rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { margin: 0; }
</style>
</head>
<body>
<div>
<h1>Just a moment</h1>
<p>${message}</p>
</div>
</body>
</html>
`;
}

export function middleware(req: NextRequest) {
  // §5.4, first: the cheapest refusal in the file, and the only one that protects a page render.
  const flooded = linkRefusal(req);
  if (flooded) return flooded;

  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value ?? null;

  if (isStateChanging(req.method)) {
    const reason = checkCsrf({
      method: req.method,
      pathname: req.nextUrl.pathname,
      serverAction: req.headers.get(SERVER_ACTION_HEADER),
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      headerToken: req.headers.get(CSRF_HEADER),
      urlToken: req.nextUrl.searchParams.get(CSRF_PARAM),
      cookieToken,
    });
    if (reason) {
      // The reason is a header name, never a token. lib/log.ts cannot be imported here (node:async_hooks),
      // so the response carries it instead: the browser console says what is missing, and `code` is what a
      // support request quotes. A 403 is deliberate — the request was understood and refused.
      //
      // next.config.ts applies the static headers to responses the router produces, not to one middleware
      // returns itself, so this refusal sets them too: no response leaves without them.
      const headers = new Headers({ "x-csrf-blocked": reason, "Cache-Control": "no-store" });
      for (const h of STATIC_SECURITY_HEADERS) headers.set(h.key, h.value);
      return NextResponse.json(
        { error: `This request was blocked for security reasons: ${reason}. Reload the page and try again.`, code: "csrf_failed" },
        { status: 403, headers },
      );
    }
  }

  // The nonce has to reach Next before it renders. Next reads it off the request's own
  // Content-Security-Policy header and stamps it onto every script and preload tag it emits.
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { dev: isDev, formAction: FORM_ACTION_EXTRA });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);

  if (!cookieToken) {
    res.cookies.set(CSRF_COOKIE, newCsrfToken(), {
      // Readable by our own JavaScript on purpose: the page has to copy it into the header. That is the
      // whole scheme, and it is safe because another origin still cannot read it.
      httpOnly: false,
      sameSite: "lax",
      secure: overTls(req),
      path: "/",
      maxAge: CSRF_COOKIE_MAX_AGE,
    });
  }
  return res;
}
