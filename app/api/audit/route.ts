// GET /api/audit                -> { entries, total, actors } for the caller's own practice (design §10.2)
// GET /api/audit?format=csv     -> the same rows as a CSV attachment ("exportable")
// Owner: compliance.
//
// Filters, all optional and combinable: `action`, `actorId`, `entityId`, `from`, `to` (both `YYYY-MM-DD`,
// `to` inclusive of that day), `limit`. lib/auditLog.ts parses them; an action nobody writes simply matches
// nothing, which is the honest answer to asking for it.
//
// Admin only (§10.2, "readable by practice admins"), and there is no practice id in the path: the session
// says which practice, so a user cannot read another one's log by editing a URL (§5.2). The log is also the
// one table whose rows outlive what they describe, so it is read-only from the outside — nothing here, and no
// other route, offers a way to edit or delete a row.

import { NextResponse } from "next/server";
import { auditCsv, auditCsvFilename, parseAuditFilter } from "@/lib/auditLog";
import { auditListing } from "@/lib/auditStore";
import { requireCapability } from "@/lib/guard";
import { withRoute } from "@/lib/log";

async function getHandler(req: Request) {
  const me = await requireCapability("audit:read");
  const params = new URL(req.url).searchParams;
  const filter = parseAuditFilter(params);
  const listing = await auditListing(me.practiceId, filter);

  if (params.get("format") === "csv") {
    return new NextResponse(auditCsv(listing.entries), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${auditCsvFilename()}"`,
        // An export of who read what is not something to leave in a shared cache.
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json(listing, { headers: { "cache-control": "no-store" } });
}

export const GET = withRoute("GET /api/audit", getHandler);
