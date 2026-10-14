# Security headers, CSRF, rate limits, and the dependency audit

Fulfils design §10.8 (security headers, CSRF protection on state-changing routes, dependency audit in CI),
§5.4 (rate limits on the public routes) and §12.4 (the audit runs on every pull request).

Four separate things live here because they fail in four different ways: a header that is missing on half
the responses, a route that trusts a cookie it should not, a public route anyone can call as often as they
like, and a dependency nobody re-checked.

---

## 1. Security headers

| Header | Value | Set in |
|---|---|---|
| `Content-Security-Policy` | see below | `middleware.ts` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | `next.config.ts` |
| `X-Frame-Options` | `DENY` | `next.config.ts` |
| `Referrer-Policy` | `no-referrer` | `next.config.ts` |
| `X-Content-Type-Options` | `nosniff` | `next.config.ts` |
| `Permissions-Policy` | everything off except `microphone=(self)` | `next.config.ts` |
| `Cross-Origin-Opener-Policy` | `same-origin` | `next.config.ts` |
| `Cross-Origin-Resource-Policy` | `same-origin` | `next.config.ts` |
| `X-DNS-Prefetch-Control` | `off` | `next.config.ts` |

The values are one list, `STATIC_SECURITY_HEADERS` in `lib/security.ts`, so the two call sites cannot drift.

`Referrer-Policy: no-referrer` is not a nicety here. A patient's intake link is a bearer token in a URL
(§5.3): any outbound request from that page would otherwise put the token in a `Referer` header. The
microphone stays on because Sweetie's voice mode is the browser's own speech recognition (`lib/voice.ts`).

### The CSP and why it is set in middleware

```
default-src 'self'; script-src 'self' 'nonce-<per response>' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self'; worker-src 'self' blob:;
manifest-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self';
form-action 'self'; upgrade-insecure-requests
```

Next.js serves its own inline bootstrap scripts — the `self.__next_f.push(...)` calls that carry the
server-rendered payload to the client — so `script-src 'self'` alone leaves the app unable to hydrate. The
two ways out are `'unsafe-inline'`, which gives up most of what a CSP buys, and a fresh nonce on every
response. We take the nonce: `middleware.ts` generates one, sets it on the *request's*
`Content-Security-Policy` header, which is where Next looks for it, and Next stamps it onto every script and
preload tag it emits.

`'strict-dynamic'` is what makes the nonce worth having: a browser that understands it ignores the host
allow-list for scripts entirely, so a `<script src="/_next/…">` that an injection manages to write is refused
even though it points at our own origin.

A nonce cannot come from `next.config.ts`, which is evaluated once at build time, so **the CSP is set in
middleware and nowhere else**. Two `Content-Security-Policy` headers on one response are enforced as the
intersection of both, which is how a well-meant second policy turns a working page blank.

Two deliberate relaxations:

- `style-src 'unsafe-inline'`. `next/font/google` inlines an `@font-face` block, Tailwind ships inline styles
  during a build, and Recharts sets a `style` attribute on every element it draws. A style injection cannot
  run code, and the alternative is a policy nobody can keep green.
- `'unsafe-eval'` and `ws:` **in development only**. `next dev` evaluates its hot-reload runtime and talks to
  itself over a websocket. A build does neither, and the e2e suite and every deployed environment run a build.

`e2e/security.spec.ts` asserts the headers on a running build, that the nonce changes between responses, and
that the provider dashboard — charts and all — loads with no CSP violation in the console.

---

## 2. CSRF

Both of this app's sessions are cookies: Auth.js's session cookie for a signed-in provider (`lib/auth.ts`,
T05) and the patient's visit link. A browser sends a
cookie on any request to this origin, whichever page started it, so without a second factor a page on
another site could POST `/api/invite` or `/api/upload` in the background and the request would arrive
carrying a clinician's session. Nothing in the route can tell that apart from a click on our own dashboard.

That sentence is also the limit of what this protects, and it is what the two exemptions below turn on. The
attack needs an **ambient** credential — something the browser attaches on its own. A request that has none
has nothing to ride.

The scheme is the **cookie-to-header token** (double submit), in `lib/csrf.ts` and enforced in
`middleware.ts` before any route handler runs:

1. Middleware hands out a random 32-byte token in the `ss_csrf` cookie — `SameSite=Lax`, `Secure` outside
   development, and deliberately **not** `HttpOnly`, because the page has to copy it into a header. Another
   origin still cannot read it.
2. Every request with an unsafe method (anything but `GET`, `HEAD`, `OPTIONS`) must repeat that value in the
   `x-csrf-token` header.
3. When the browser sent an `Origin` (or, failing that, a `Referer`), its host must equal the request's host —
   `x-forwarded-host` first, so this still holds behind the load balancer.

Three independent checks rather than one clever one. A failure is a `403` with
`{ "code": "csrf_failed" }`, a plain-language `error`, and an `x-csrf-blocked` header naming what was missing.
It never echoes a token.

**Writing client code.** Use `apiFetch` from `lib/csrf.ts` instead of `fetch` for anything that changes
state; it attaches the header. A plain `fetch` with a `POST` gets a `403`, which is the point — the mistake is
loud and local instead of a hole nobody notices.

```ts
import { apiFetch } from "@/lib/csrf";
const res = await apiFetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId }) });
```

### The three exemptions

Each one is a hole by construction, so each is narrow, named in code, and tested for the shape of the hole.
None can be reached by a cross-site page: a `<form>` cannot set a request header at all, and a cross-origin
`fetch` that sets one needs a CORS preflight this app never answers. **The Origin check (3 above) runs for
every request either way** — standing down on the token is not standing down on that — so every exemption
keeps a second lock, and a unit test fails until anyone adding a fourth comes and writes it down here.

**1. `POST /api/jobs/run`, by path** (`CSRF_EXEMPT_PATHS` in `lib/csrf.ts`). This is the §3.4 runner.
EventBridge Scheduler calls it once a minute with `Authorization: Bearer <JOBS_SECRET>` and nothing else: no
cookie, no Origin, and no page to have read a token from. A challenge in front of it answers 403 before
`authorizeRunner` runs, and the queue then never drains in a deployed environment — no invite texts, no
summary emails, no `sour.run`, no retention sweep. It is sound because the route grants nothing on the
strength of a cookie: its only authority is the bearer secret, which it checks itself and refuses without
(401, or 503 where none is configured). A cross-site page can make a browser send our cookies; it cannot
make it send that header, and the cookie buys the caller nothing here anyway.

The bar for adding a path to that list: **the route must grant nothing on the strength of a cookie.** If it
reads a session, it is not exempt, whatever else it also checks. The list is matched exactly, never by
prefix, so `/api/jobs/runner-admin` is challenged like everything else the day someone adds it.

**2. Everything under `/api/auth/`, by prefix** (`CSRF_EXEMPT_PREFIXES`). This is Auth.js's mount point
(T05, `lib/auth.ts`), and it runs this exact check for itself: it double-submits its own `authjs.csrf-token`
cookie against a `csrfToken` form field on every action it accepts. Its POSTs come from `signIn()` and
`signOut()` in `next-auth/react` — library code with nowhere to add our header — so challenging it a second
time only breaks its client. It did: `POST /api/auth/signin/email` answered `403` with
`x-csrf-blocked: no x-csrf-token header`, which is provider sign-up failing on its last step.

This is the only prefix, and the bar for a second is higher than for a path: the code under it must be a
library performing its own CSRF check on every state-changing route, and the entry must name that check.
"This subtree is awkward" is not a reason — we own everything else under `/api`. The prefix stops at a path
separator, so a route of our own named `/api/authority` is challenged like any other.

**3. A Next.js Server Action**, recognised by the `Next-Action` header. No application code issues the
request — Next posts it to the page's own URL with that header and whatever cookies the browser has — so
there is nowhere to stamp `x-csrf-token`, and inventing one would mean patching Next's own client. Next runs
its own Origin-against-Host check on Server Actions before invoking the action, and step 3 above runs too;
this exemption only stands down **when that check actually verified an Origin**, which a Server Action POST
from a browser always carries. T05's provider sign-in and sign-out (`app/provider/actions.ts`) are the
ones this carries today, and they are the only way into the app, so `e2e/signin.spec.ts` exercising them end
to end is also this rule's test.

**The one caller that cannot set a header** is the sandbox Dexcom button, a plain `<form method="POST">`
whose response is a cross-origin redirect to Dexcom's authorization page. It sends the token as `?csrf=` on
the form action instead. Reading it out of the body is not an option: consuming the request stream in
middleware would leave route handlers with an empty body and break every multipart upload. The query string
is as unguessable to another origin as the header is, and `Referrer-Policy: no-referrer` keeps the URL from
travelling anywhere.

**Tests.** `lib/csrf.test.ts` covers the decision itself, both halves: `checkCsrf` including each exemption
and the shape of each hole, and the client functions (`readCsrfToken`, `ensureCsrfToken`, `apiFetch`) against
a stubbed `document.cookie`, since a bug there is a page whose every POST fails and nothing else catches it.

`e2e/security.spec.ts` posts to `/api/book` with no token, with a mismatched token, and from a forged
origin, then with the real token to show the same call succeeds. It also drives `/api/jobs/run` against the
third server in `playwright.config.ts` — the only one with a `JOBS_SECRET`, which is what makes the route
answer the way production does — asserting 401 without the secret (**not** 403, which would mean middleware
answered first), a drain report with it, a 403 for a cross-site post that carries the secret, and a 403 for
a neighbouring path. For Auth.js it asserts the three that matter: a real `signIn()` POST reaches Auth.js
(302 to its verify page, no `x-csrf-blocked`), a forged `csrfToken` is refused **by Auth.js**
(`error=MissingCSRF`), and a cross-site one is still refused by us. `e2e/api.ts` is how the suite's own
direct API calls do the handshake.

A refusal from middleware carries the static headers too: `next.config.ts` applies them to responses the
router produces, not to one middleware returns itself, so no response leaves without them.

### Adding a route

A new route under `app/api/**` is covered automatically — middleware matches everything but static output.
If a route ever needs to be exempt (an inbound webhook signed by the sender, for example), say so in
`middleware.ts` with the reason and the signature check that replaces this one. Do not widen the matcher.

### Adding a Server Action

Covered: exemption 3 above lets it through on a verified Origin, which is also what Next checks for itself.
Nothing to do.

---

## 3. Rate limits on the public routes

Fulfils design §5.4: "Rate limits on `/api/sweetie`, `/api/upload`, the code endpoints, and the invite link
route, keyed by IP and by visit."

Everything is in `lib/ratelimit.ts`. Four routes, two keys each, one table:

| Route | Where the check runs | Per visit | Per IP |
|---|---|---|---|
| `/s/<token>` and the intake page under it | `middleware.ts` | 60 / min | 600 / min |
| `POST /api/verify` (ask for a code, type one back) | the handler | 12 / min | 300 / min |
| `GET`/`POST /api/sweetie` | the handler | 60 / min | 300 / min |
| `POST`/`DELETE /api/upload` | the handler | 20 / min | 120 / min |

### Why two keys

They catch different things, and neither on its own is enough.

**By visit** is the precise lock. One visit is one patient's half-hour of intake, so a visit asking for its
fortieth six-digit code is not a patient, and the key holds however that caller is connected — a VPN, a phone
and a laptop at once, a fresh address per request. The per-visit numbers are set from what the screen in
front of the patient can produce: the code screen asks for a code on mount and on each "Send a new code",
Sweetie is one message a turn, the intake page one upload a button. Each is several times the busiest honest
run of that screen.

**By IP** is the blunt backstop, for the flood the per-visit key cannot see because every request names a
different visit — a token-enumeration sweep over the link route is exactly that shape. It is deliberately
loose, a ceiling in requests per second rather than a per-patient budget: patients arrive through carrier
NAT, where one address stands for a whole city, and a clinic waiting room is one address too, so a tight
per-IP number locks out real patients long before it inconveniences anyone.

What this is *not* is the brute-force defence for the codes themselves. Three wrong tries kill a code and
ten minutes kill it anyway (§5.3, `lib/patientSession.ts`). §5.4 is about load and about cost — every code
request is an SMS or an email somebody pays for.

### Where each check runs, and in what order

The three API routes limit themselves in the handler, in two steps:

1. **By IP, first thing** — before the body is read. On `/api/upload` that is the only check that can refuse a
   20 MB request without reading it (§9.1), and on `/api/sweetie` it is in front of the model call.
2. **By visit, once the token has named one** — so a request with an unknown token never gets a window of its
   own. On `/api/sweetie` and `/api/upload` this sits *after* the verified-session check, on purpose: a 401
   costs almost nothing, and someone a link was forwarded to must not be able to spend the real patient's
   window. On `/api/verify` it sits in front of both halves of the route, because spamming the patient's phone
   with codes is the thing being prevented.

The link route is a page, so it has no handler to put a check in, and `middleware.ts` is the only thing in
front of it. Middleware runs on the edge runtime and cannot reach the database to turn a token into a visit
id, so the per-visit window there is keyed by a fingerprint of the token, which names the visit (§5.3).
A fingerprint and not the token itself: a patient's live link should not be sitting in a map key. Its refusal
is an HTML page rather than JSON — whoever is reading it typed a link into a browser — and it carries the
§10.8 static headers like any other response middleware returns itself.

Every refusal is a `429` with `Retry-After` in seconds, `Cache-Control: no-store`, and one plain sentence:
*"Too many requests just now. Please wait about 24 seconds and try again."* No numbers about the limit, so a
caller learns when to come back and nothing about the shape of the ceiling. The code screen already shows
whatever `/api/verify` says, so the patient sees that sentence with no new code on that page.

A refusal is also one log line, `rate_limited`, through `withRoute` (`docs/LOGGING.md`). It carries the route,
which key was spent (`ip` or `visit`), the ceiling, the retry seconds, and the visit id where there is one.
**Never the address**: an IP is an identifier, and §10.3's allow-list is the thing that keeps it out.

### In memory means per instance — and the production option

The windows are counted in a `Map` in the app process. Fixed windows: a count and the instant it resets.

That has one consequence worth being plain about. Two app servers behind the load balancer each allow the
numbers above, so the real limit is the number in the table times the instance count, and a deploy resets
every window. For a cost control that is a fair trade — no new dependency, nothing that can fail in a way
that takes the app down with it — but it is not a security boundary, which is why nothing in §5.3 or §10.2
rests on it.

The production option is to move the counting into a store every instance shares. `RateLimitStore` in
`lib/ratelimit.ts` is the entire seam:

```ts
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Window;  // count one request, return { count, resetAt }
  reset(): void;
}
```

Two implementations fit it with no other change:

- **ElastiCache (Redis)** — `INCR` on `<key>:<window start>` plus `EXPIRE windowMs`, which is the canonical
  fixed-window counter and one round trip. The ceiling then holds across instances. Costs a VPC-attached
  cache and a dependency that can be down; `hit` should fail open (allow the request, log it) rather than
  refuse a patient because a cache is unreachable.
- **DynamoDB** — `UpdateItem` with an `ADD` on the counter and a TTL attribute on the row. No new
  infrastructure beyond a table, and it fits the per-request write volume of a clinic comfortably.

Pick one when the app runs on more than one instance. Until then the in-memory store is the honest answer,
and `MAX_KEYS` (20,000 windows, oldest and already-closed first) is what keeps it from becoming a memory leak
when someone sweeps the link route from a botnet.

### Testing it

`lib/ratelimit.test.ts` covers the windows, the eviction, the key derivation and the message, with the clock
and the store passed in so nothing waits on real time. `e2e/ratelimit.spec.ts` drives the shipped limits
end to end: a burst of code requests for one visit gets the 429 and the sentence on the code screen, another
visit booked at the same moment is unaffected, and the link route answers a burst with its HTML page. The
per-IP ceilings are not driven from a test on purpose — tripping one would take the rest of the suite's
traffic down with it.

---

## 4. Dependency audit

`npm audit --audit-level=high` runs on every pull request, as the `== dependency audit` step of
`scripts/agent-check.sh` (which is all CI runs — `.github/workflows/ci.yml`). Run it alone with:

```bash
npm run audit:deps
```

`scripts/audit.ts` is a thin shell over `lib/audit.ts`: it runs the npm command, subtracts the advisories
recorded in `security/audit-exceptions.json`, prints what is left, and fails the build if anything is.

Why subtract anything at all: `npm audit` is all or nothing, and one advisory with no published fix — today,
`postcss`, which every Next.js release depends on — makes the bare command red forever. A check that is
always red is a check nobody reads. Subtracting a written-down list keeps the gate meaningful: a new advisory
is still a red build on the pull request that introduced it.

Outside CI, a registry that cannot be reached is a `SKIP` with a warning. In CI it is a failure.

### The exception process

An advisory at high or critical stays in the tree only with an entry in `security/audit-exceptions.json`:

```json
{
  "advisory": 1240992,
  "package": "braces",
  "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  "scope": "devDependency, via eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch",
  "reason": "Denial of service on a deeply nested glob pattern. Reached only by eslint expanding the file globs in eslint.config.mjs, which we wrote. Not in the deployed app. The only fix npm offers is eslint-config-next 14.2.35, which does not support Next 15.",
  "owner": "compliance",
  "expires": "2027-01-09"
}
```

Every field is required and the gate refuses a half-filled entry. The order to try, before writing one:

1. **Upgrade.** `npm audit fix` for anything non-breaking; a direct dependency bump where that is what it
   takes. This is the answer most of the time.
2. **Check the reach.** Say in the `reason` whether the code runs in the deployed app, only at build time, or
   only on a developer's machine, and what an attacker would have to control to reach it. "It is only a dev
   dependency" is a conclusion, not a reason — write down the path.
3. **Then the exception**, with a named `owner` and an `expires` no more than 90 days out.

The date is the part that matters. The gate **fails** once an exception expires, so an exception nobody
re-assessed stops working on its own rather than quietly becoming permanent. On that date the owner either
upgrades or writes a fresh assessment with a new date. An exception that stops matching anything (fixed
upstream) prints `STALE` and should be deleted; that one is a warning, not a failure, so it does not turn an
unrelated pull request red.

Anything **critical** that is reachable from the deployed app does not get an exception. Pin, patch, or
replace the dependency.

The current exceptions and the reasoning behind each are in `security/audit-exceptions.json`. They are all
dev-time or build-time: `postcss` (two advisories, no fixed release exists, build only), `deepmerge-ts` (the
Prisma CLI), and `braces` (eslint). `lib/audit.test.ts` asserts that none of them has expired, so the unit
suite is the thing that reminds us.
