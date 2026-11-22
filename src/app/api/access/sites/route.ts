import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { listSitesForRequest } from "@/lib/access/grants";
import { withTenantRoute } from "@/lib/tenant/request";
import { loadTicketSystem, systemLabel } from "@/lib/ticketing/system";
import { effectiveMode, type TicketKind } from "@/lib/ticketing/rules";

export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [rows, sys] = await Promise.all([listSitesForRequest(user.id), loadTicketSystem()]);
  // Each resource says whether a ticket number is needed ("required"), and
  // whether an approved ticket opens it at once ("itsm").
  const sites = rows.map(({ ticketMode, ...s }) => ({ ...s, ticket: effectiveMode(ticketMode, sys) }));
  const ticketing = { system: systemLabel(sys), kind: (sys?.kind ?? "none") as TicketKind, checked: !!sys && sys.kind !== "none" && !!sys.baseUrl };
  return NextResponse.json({ sites, ticketing });
});
