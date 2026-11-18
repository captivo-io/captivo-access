import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { RecoveryView } from "./recovery-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recovery" };

async function RecoveryPageImpl() {
  const user = await requireUser();
  const [totp, ws] = await Promise.all([
    db.totpSecret.findUnique({ where: { userId: user.id }, select: { confirmedAt: true } }),
    workspaceView().catch(() => ({ slug: null as string | null })),
  ]);
  return <RecoveryView workspace={ws.slug} setUpAt={totp?.confirmedAt?.toISOString() ?? null} />;
}

export default async function RecoveryPage(...args: Parameters<typeof RecoveryPageImpl>) {
  return withRequestTenant(() => RecoveryPageImpl(...args));
}
