// Auth.js endpoints: /api/auth/signin, /callback, /session, /signout, /csrf (design §5.1).
// The handlers are Auth.js's own; withRoute only adds the request id and the one access log line every route
// in this app writes (docs/LOGGING.md). Nothing here logs an address or a link token.

import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { withRoute } from "@/lib/log";

export const GET = withRoute("GET /api/auth", (req: NextRequest) => handlers.GET(req));
export const POST = withRoute("POST /api/auth", (req: NextRequest) => handlers.POST(req));
