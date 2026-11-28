import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { parseGroupInput } from "@/lib/connector/groups";
import { GroupSaveError, saveConnectorGroup } from "@/lib/connector/group-save";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { reshareGroupSecrets } from "@/lib/vault/reshare";

export const dynamic = "force-dynamic";

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const input = parseGroupInput(await req.json().catch(() => null));
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
  let id: string;
  try {
    id = await saveConnectorGroup(null, input.name, input.members, input.replicate);
  } catch (e) {
    if (e instanceof GroupSaveError) return NextResponse.json({ error: e.message }, { status: e.message === "name_taken" ? 409 : 400 });
    throw e;
  }
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "connector.group_create", targetType: "connector_group", targetId: id,
    summary: `Created connector group "${input.name}" with ${input.members.length} connector${input.members.length === 1 ? "" : "s"}${input.replicate ? ", keeping a copy of recordings on each member" : ""}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  // Members without a copy of a resource's saved password get one from a member that has it.
  await reshareGroupSecrets({ groupIds: [id] }, { id: admin.id, email: admin.email }).catch((e) => console.error("vault: copying secrets to the group failed", e));
  return NextResponse.json({ id });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
