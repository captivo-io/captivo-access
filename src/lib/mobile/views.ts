import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import { currentTenantId } from "@/lib/tenant/context";
import { consoleBaseUrl } from "@/lib/tenant/console-url";

/** What the app is told about the signed-in person. */
export function userView(u: { id: string; name: string; email: string; role: Role }) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    can: { approve: can(u.role, "approve_grants"), configure: can(u.role, "configure") },
    platform: u.role === "PLATFORM",
  };
}

export async function workspaceView() {
  const t = await db.tenant.findUnique({ where: { id: currentTenantId() }, select: { name: true, slug: true } });
  return { name: t?.name ?? "Captivo Access", slug: t?.slug ?? null, origin: await consoleBaseUrl() };
}
