import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { saveOidcConfig, deleteOidcConfig } from "@/lib/auth/oidc-config";
import { isPlatformIssuer, readPlatformOidc } from "@/lib/auth/oidc-source";
import { withTenantRoute } from "@/lib/tenant/request";

export const POST = withTenantRoute(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const issuer = typeof b.issuer === "string" ? b.issuer.trim() : "";
  const clientId = typeof b.clientId === "string" ? b.clientId.trim() : "";
  const enabled = b.enabled === true;
  const clientSecret = typeof b.clientSecret === "string" ? b.clientSecret : undefined;
  const buttonLabel = typeof b.buttonLabel === "string" ? b.buttonLabel : null;

  if (!issuer || !clientId) return NextResponse.json({ error: "issuer_client_required" }, { status: 400 });
  // Captivo ID is already the sign-in on Cloud; as a tenant's "own" provider it
  // could only be saved without its secret, and would replace the working one.
  if (isPlatformIssuer(issuer, readPlatformOidc(process.env))) return NextResponse.json({ error: "captivo_id_issuer" }, { status: 400 });
  // Enabling requires a secret to exist (either provided now or already stored).
  if (enabled && !(clientSecret && clientSecret.length > 0)) {
    const { getOidcConfig } = await import("@/lib/auth/oidc-config");
    const existing = await getOidcConfig();
    if (!existing?.hasSecret) return NextResponse.json({ error: "secret_required" }, { status: 400 });
  }

  await saveOidcConfig({ enabled, issuer, clientId, clientSecret, buttonLabel });
  await recordAdminAction({
    actor: { id: user.id, email: user.email },
    action: "config.sso_update",
    summary: "Updated SSO settings",
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

/** Remove the tenant's own provider; sign-in falls back to Captivo ID on Cloud, passkeys elsewhere. */
export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const removed = await deleteOidcConfig();
  if (removed) {
    await recordAdminAction({
      actor: { id: user.id, email: user.email },
      action: "config.sso_remove",
      summary: "Removed SSO settings",
      clientIp: clientIp(req.headers) ?? null,
    });
  }
  return NextResponse.json({ ok: true, removed });
});
