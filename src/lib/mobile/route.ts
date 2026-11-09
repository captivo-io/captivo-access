import { NextResponse } from "next/server";
import { can, type Capability } from "@/lib/auth/roles";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { withTenantRoute } from "@/lib/tenant/request";
import type { TenantScopeOptions } from "@/lib/tenant/scope";
import { mobileSessionFromRequest } from "./session";

type MobileSession = NonNullable<Awaited<ReturnType<typeof mobileSessionFromRequest>>>;

export function mobileJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * An /api/mobile route: the workspace comes from the host like every console
 * route, the person from the app's bearer token, and `cap` is checked against
 * their CURRENT role on every call -- a role the centre lowered an hour ago is
 * the role that answers. With several capabilities, any one of them is enough.
 *
 * manage_tenants counts only on the platform host: the PLATFORM role exists
 * only there, and pinning the host too means a mis-scoped request still fails.
 */
export function mobileCan(role: Parameters<typeof can>[0], cap: Capability): boolean {
  if (cap === "manage_tenants" && currentTenantId() !== PLATFORM_TENANT_ID) return false;
  return can(role, cap);
}

export function mobileRoute<C>(
  cap: Capability | Capability[],
  handler: (req: Request, session: MobileSession, ctx: C) => Promise<Response>,
  opts?: TenantScopeOptions,
): (req: Request, ctx: C) => Promise<Response> {
  return withTenantRoute(async (req: Request, ctx: C) => {
    const session = await mobileSessionFromRequest(req);
    if (!session) return mobileJson({ error: "unauthorized" }, 401);
    const caps = Array.isArray(cap) ? cap : [cap];
    if (!caps.some((c) => mobileCan(session.user.role, c))) return mobileJson({ error: "forbidden" }, 403);
    return handler(req, session, ctx);
  }, opts);
}
