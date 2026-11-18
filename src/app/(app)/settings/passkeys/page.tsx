import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { accountState } from "@/lib/auth/account-state";
import { withRequestTenant } from "@/lib/tenant/request";
import { PasskeysView, type PasskeyRow } from "./passkeys-view";

// The passkey list must be read fresh on every request.
export const dynamic = "force-dynamic";
export const metadata = { title: "Passkeys" };

async function PasskeysPageImpl() {
  const user = await requireUser();
  // Only serializable fields: counter (BigInt) and publicKey (Bytes) aren't needed.
  const [passkeys, state, ws] = await Promise.all([
    db.passkey.findMany({
      where: { userId: user.id },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true, backedUp: true },
      orderBy: { createdAt: "asc" },
    }),
    accountState(user.id),
    workspaceView().catch(() => ({ slug: null as string | null })),
  ]);
  const rows: PasskeyRow[] = passkeys.map((p) => ({
    id: p.id,
    label: p.label,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    synced: p.backedUp,
  }));
  return <PasskeysView passkeys={rows} recoveryOn={state.recoveryOn} workspace={ws.slug} />;
}

export default async function PasskeysPage(...args: Parameters<typeof PasskeysPageImpl>) {
  return withRequestTenant(() => PasskeysPageImpl(...args));
}
