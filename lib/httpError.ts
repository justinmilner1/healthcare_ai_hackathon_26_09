// The one way a route says no (design §5.2, §11.1). Owner: identity.
//
// A guard in lib/guard.ts throws one of these; `withRoute` in lib/log.ts catches it, writes the access line
// for the request at warn level with the reason as its event name, and sends the body below. So a route that
// refuses is one line in the handler — `const me = await requireCapability("visits:create")` — rather than an
// if/return pair per check, and no refusal can be forgotten on the way out.
//
// `message` is what the caller reads, so it says what they may do about it and nothing about what is behind
// the refusal: §5.2 keeps another practice's data invisible, and "visit not found" has to mean both "there is
// no such visit" and "it is not yours" or the 404 itself is the answer. The fields that say which user and
// which practice were turned away go to the log instead, where §10.3's allow-list applies.

import type { Fields } from "./log";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The log event name for this refusal, e.g. `request_forbidden`. Replaces `request` on the access line. */
    readonly event: string = "request_refused",
    /** Allow-listed fields for the log line only. Never sent to the caller. */
    readonly fields: Fields = {},
    /** Extra response headers, for a status whose meaning is partly in them: `Retry-After` on the 429 a rate
     *  limit throws (lib/ratelimit.ts, §5.4). Headers, so they must say nothing the body may not. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }

  /** The response the caller gets. Plain `Response`, so lib/log.ts needs nothing from next/server. */
  response(): Response {
    return new Response(JSON.stringify({ error: this.message }), {
      status: this.status,
      headers: { "content-type": "application/json", ...this.headers },
    });
  }
}
