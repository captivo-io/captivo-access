import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { getOidcConfig } from "@/lib/auth/oidc-config";
import { closeFacts, workspaceCounts, SUPPORT_ADDRESS } from "@/lib/workspace/close";
import { closeRefusal, restorableUntil, FRESH_AUTH_MS } from "@/lib/workspace/close-gate";
import { PURGE_AFTER_DAYS } from "@/lib/platform/tenants";
import { withRequestTenant } from "@/lib/tenant/request";
import { CloseWorkspaceView } from "./close-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Close workspace" };

async function CloseWorkspacePageImpl() {
  const user = await requireUser();
  const ws = await workspaceView().catch(() => ({ name: "", slug: null as string | null }));
  const facts = await closeFacts(user, ws.slug);
  const refusal = closeRefusal(facts);
  if (refusal === "not_available") notFound();
  if (refusal === "forbidden") redirect("/");

  const [counts, oidc, passkeys] = await Promise.all([
    workspaceCounts(),
    getOidcConfig().catch(() => null),
    db.passkey.count({ where: { userId: user.id } }),
  ]);
  const until = restorableUntil(facts.now, PURGE_AFTER_DAYS).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <main className="wc">
      <div className="page-head">
        <div>
          <div className="eyebrow">Policy · {ws.slug}</div>
          <h1>Close workspace</h1>
          <p>Closing <b>{ws.name || ws.slug}</b> takes it offline for everyone at once. Read what happens before you go on.</p>
        </div>
      </div>
      <CloseWorkspaceView
        slug={ws.slug as string}
        counts={counts}
        until={until}
        support={SUPPORT_ADDRESS}
        state={refusal === "support_session" ? "support" : refusal === "reauth_required" ? "reauth" : "ready"}
        // Re-checked by the route on submit; this only lets the page notice expiry on its own.
        freshForMs={facts.sessionCreatedAt ? Math.max(0, FRESH_AUTH_MS - (facts.now.getTime() - facts.sessionCreatedAt.getTime())) : 0}
        reauth={{ captivo: !!oidc?.enabled && !!user.centerRole, passkey: passkeys > 0, sso: !!oidc?.enabled }}
      />
    </main>
  );
}

export default async function CloseWorkspacePage(...args: Parameters<typeof CloseWorkspacePageImpl>) {
  return withRequestTenant(() => CloseWorkspacePageImpl(...args));
}
