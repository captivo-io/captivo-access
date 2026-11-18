import { db } from "@/lib/db";

/**
 * What the account menu needs about the signed-in person: whether recovery is
 * set up (the menu and the tab carry a warn dot until it is) and whether
 * Captivo ID manages the account (then "Captivo account ↗" is offered).
 */
export interface AccountState { recoveryOn: boolean; idLinked: boolean }

export async function accountState(userId: string): Promise<AccountState> {
  const [u, totp] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { centerRole: true } }),
    db.totpSecret.findUnique({ where: { userId }, select: { confirmedAt: true } }),
  ]);
  return { recoveryOn: !!totp?.confirmedAt, idLinked: !!u?.centerRole };
}
