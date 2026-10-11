// Security response headers (design §10.8). Owner: compliance.
//
// One source of truth for two call sites, because a header that only exists on half the responses is worse
// than no header at all:
//
//   next.config.ts  applies STATIC_SECURITY_HEADERS to every route. These never change per request.
//   middleware.ts   adds the Content-Security-Policy, which does: it carries a per-request nonce.
//
// The split is the nonce. Next.js serves its own inline bootstrap scripts (the `self.__next_f.push(...)`
// that carry the server-rendered payload to the client), so a policy of `script-src 'self'` blocks the app
// from hydrating. The two ways out are `'unsafe-inline'`, which un-does most of what a CSP buys, and a
// fresh nonce per response, which Next reads off the request's own Content-Security-Policy header and
// stamps onto every script and preload tag it emits. We take the nonce. A nonce cannot come from
// next.config, which is evaluated once at build time, so the CSP is set in middleware and nowhere else —
// two Content-Security-Policy headers on one response are enforced as the intersection of both, which is
// how a well-meant second policy breaks a page.

/** Headers with no per-request part. Applied in next.config.ts to every route. */
export const STATIC_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  // Transport security (§10.1). Two years, subdomains included, preload-eligible. Ignored over plain HTTP,
  // so it costs nothing locally; in front of the ALB and CloudFront it is the whole point.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Framing. frame-ancestors in the CSP is the modern control; this is the one older browsers obey.
  { key: "X-Frame-Options", value: "DENY" },
  // A visit link is a bearer token in a URL (§5.3). Referrer-Policy keeps it out of the Referer header on
  // the way to any third party, which is how presigned links leak.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing in either flow needs a camera, a location, or a payment sheet. Speech recognition in
  // lib/voice.ts is the browser's own Web Speech API and needs the microphone.
  { key: "Permissions-Policy", value: "accelerometer=(), camera=(), display-capture=(), geolocation=(), microphone=(self), payment=(), usb=()" },
  // Cross-origin isolation: a window we open cannot reach back into ours, and nothing else can read our
  // responses as a resource.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** 16 random bytes, base64. The nonce is public by design; it only has to be unguessable per response. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The Content-Security-Policy for one response.
 *
 * `'strict-dynamic'` is what makes the nonce worth having: a browser that understands it ignores the
 * host allow-list for scripts entirely, so a tag an injection manages to write is refused even though it
 * points at our own origin. Next's nonce-bearing bootstrap then loads the chunks it needs.
 *
 * Styles keep `'unsafe-inline'`: next/font/google inlines an @font-face block, Tailwind's preflight ships
 * inline during a build, and Recharts sets style attributes on every element it draws. A style injection
 * cannot run code, and the alternative is a policy nobody can keep green.
 */
export function contentSecurityPolicy(nonce: string, { dev = false }: { dev?: boolean } = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const connect = ["'self'"];
  if (dev) {
    // `next dev` evaluates its HMR runtime with eval and talks to itself over a websocket. Neither exists
    // in a build, which is what the e2e suite and every deployed environment run.
    script.push("'unsafe-eval'");
    connect.push("ws:", "wss:");
  }
  const directives: string[] = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
