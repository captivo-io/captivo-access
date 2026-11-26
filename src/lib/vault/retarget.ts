import { db } from "@/lib/db";
import { compareSemver } from "@/lib/updates/semver";
import { isSealedValue, type VaultTarget } from "@/lib/vault/seal";
import { callConnector, type RotateCall } from "@/lib/vault/rotation";
import { holderKeys, sealsOf, splitSeals, storedSecretColumns, type VaultHolder } from "@/lib/vault/store";

/** The first connector release that can move a saved password to another address or account. */
export const RETARGET_MIN_CONNECTOR = "2.79.0";

/** True when this connector can do it (an online one on 2.79.0 or later, or a dev build). */
export function canRetarget(c: { status: string; version: string | null }): boolean {
  return c.status === "ONLINE" && !!c.version && (c.version === "dev" || compareSemver(c.version, RETARGET_MIN_CONNECTOR) !== -1);
}

export type MovedSecret = {
  /** The VaultCredential columns to write: the same password, sealed for the new target. */
  columns: ReturnType<typeof storedSecretColumns>;
  from: VaultTarget;
  to: VaultTarget;
  /** The connector that did the work. */
  connectorId: string;
};
export type MoveFailure = { error: string; status: number; detail?: string };

/**
 * Moves a saved password to a new address or account WITHOUT anyone typing it again.
 *
 * A saved password is sealed to its connector's key and bound to the host, port and
 * user it was entered for (src/lib/vault/seal.ts), so the console, which never holds
 * the plaintext, cannot re-seal it. The connector can: it opens the seal for the OLD
 * target and seals it again for the NEW one, to the key of every connector that will
 * carry the resource (the new holder, which may be another connector or a group).
 * The plaintext never leaves the connector; what comes back is sealed values only.
 *
 * A credential kept in the customer's own vault, or signed in with certificates, is a
 * reference rather than a password: it is not moved here and has to be entered again.
 */
export async function moveKeptSecret(
  siteId: string,
  holder: VaultHolder,
  to: VaultTarget,
  call: RotateCall = callConnector,
): Promise<MovedSecret | MoveFailure> {
  const c = await db.vaultCredential.findUnique({
    where: { siteId },
    select: { targetHost: true, targetPort: true, username: true, secret: true, sealedTo: true, extraSeals: true, secretSource: true },
  });
  if (!c || !c.sealedTo) return { error: "vault_secret_required", status: 400 };
  if (c.secretSource) {
    return { error: "vault_secret_required", status: 400, detail: "This credential is a reference to a vault or a certificate sign-in, not a saved password: enter it again for the new address." };
  }
  const seals = sealsOf(c);
  const { keys } = await holderKeys(holder);
  if (keys.length === 0) return { error: "vault_connector_key_required", status: 409 };

  // The connector that holds a copy of the password does the work, wherever the resource is going.
  const holders = await db.connector.findMany({
    where: { vaultPublicKey: { in: Object.keys(seals) } },
    select: { id: true, status: true, version: true, vaultPublicKey: true },
    orderBy: { id: "asc" },
  });
  const pick = holders.find((h) => h.vaultPublicKey && canRetarget(h));
  if (!pick || !pick.vaultPublicKey) {
    return {
      error: "retarget_unavailable", status: 409,
      detail: `No connector that holds the saved password is online and on ${RETARGET_MIN_CONNECTOR} or later. Update or start it, or enter the password again.`,
    };
  }
  const from = { host: c.targetHost, port: c.targetPort, username: c.username };
  const ans = await call(pick.id, {
    op: "retarget", method: "linux", host: from.host, port: String(from.port), username: from.username,
    current: seals[pick.vaultPublicKey], to: keys,
    newHost: to.host.trim(), newPort: String(to.port), newUsername: to.username.trim(),
  });
  if (ans.error) return { error: "retarget_failed", status: 502, detail: ans.error };
  const out: Record<string, string> = {};
  for (const k of keys) {
    const s = ans.seals?.[k];
    if (!isSealedValue(s)) return { error: "retarget_failed", status: 502, detail: "The connector's answer was incomplete." };
    out[k] = s;
  }
  return { columns: storedSecretColumns(splitSeals(out, keys)), from, to: { host: to.host.trim(), port: to.port, username: to.username.trim() }, connectorId: pick.id };
}
