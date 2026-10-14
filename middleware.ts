// The one place every request passes through (design §10.8). Owner: compliance.
//
// Three jobs, in order:
//   1. Hand out the CSRF cookie, so the page's JavaScript has a token to echo back (lib/csrf.ts).
//   2. Refuse a state-changing request that does not echo it, before it reaches a route handler.
//   3. Set the Content-Security-Policy with this response's nonce (lib/security.ts). The headers that do
//      not change per request come from next.config.ts instead.
//
// Edge runtime: Web APIs only, no node:crypto, no Prisma. Both helpers it uses are written for that.

import { NextResponse, type NextRequest } from "next/server";
import { CSRF_COOKIE, CSRF_COOKIE_MAX_AGE, CSRF_HEADER, CSRF_PARAM, SERVER_ACTION_HEADER, checkCsrf, isStateChanging, newCsrfToken } from "@/lib/csrf";
import { contentSecurityPolicy, newNonce, STATIC_SECURITY_HEADERS } from "@/lib/security";

export const config = {
  // Everything but the static output. A hashed chunk under /_next/static is immutable and public: it needs
  // no nonce, and setting a cookie on it would make every asset response vary. Favicons likewise.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2)$).*)"],
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

export function middleware(req: NextRequest) {
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
