/**
 * Creating the workspace an entitled identity is owed.
 *
 * This is the counterpart to flow.ts. That one starts from an email nobody has
 * verified and proves the address before creating anything; this one starts
 * from a Captivo ID token that already carries a verified identity and an
 * entitlement, so what it has to establish is different: that the entitlement
 * is real (asked of the centre, never inferred from the token), and that the
 * address the workspace will live at can actually be formed.
 *
 * The dependencies are injected so the decisions can be tested without a
 * database, an RLS bootstrap or a live identity service.
 */

import { parseLimits, type TenantLimits } from "@/lib/platform/tenant-shape";

export interface EntitledDeps {
  fetchEntitlement: (organizationId: string) => Promise<{ plan: string | null; limits: Record<string, number> | null } | null>;
  create: (input: { name: string; slug: string; adminEmail: string; adminName?: string; plan?: string; limits?: TenantLimits }) => Promise<{ tenant: { id: string; slug: string }; inviteUrl: string }>;
  reportLink: (input: { organizationId: string; tenantId: string; consoleOrigin: string }) => Promise<boolean>;
  consoleOriginFor: (slug: string) => string | null;
}

const TR = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u" } as const;

/**
 * A slug proposed from the organisation's name.
 *
 * Turkish letters are folded rather than stripped: dropping them turns
 * "Güneş Otel" into "gne-otel", which reads as a typo to the customer whose
 * address it becomes. This is a SUGGESTION -- the person confirms or changes
 * it, and uniqueness is settled by the create call.
 */
export function suggestedSlug(organizationName: string): string {
  const folded = [...organizationName].map((c) => (TR as Record<string, string>)[c] ?? c).join("");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || `workspace-${Date.now().toString(36)}`;
}

export async function provisionEntitledWorkspace(
  input: { organizationId: string; organizationName: string; slug: string; adminEmail: string; adminName?: string },
  deps: EntitledDeps,
): Promise<{ ok: true; inviteUrl: string; linked: boolean } | { ok: false; error: string }> {
  // The entitlement is the authorisation, and it is ASKED OF THE CENTRE rather
  // than read from the token: the token says who this is, the centre says what
  // they bought, and those are different questions.
  const ent = await deps.fetchEntitlement(input.organizationId);
  if (!ent) return { ok: false, error: "not_entitled" };

  // Formed before anything is created: a workspace at an address we cannot
  // build is a workspace nobody can reach.
  const consoleOrigin = deps.consoleOriginFor(input.slug);
  if (!consoleOrigin) return { ok: false, error: "no_console_domain" };

  // The centre's JSON is run through the same validator the console uses, so
  // unknown keys and junk are dropped rather than trusted. But dropping
  // EVERYTHING is not the same as "no caps were meant": caps that arrived and
  // did not survive validation would leave an uncapped free workspace, which is
  // the one outcome the tier cannot afford.
  const limits: TenantLimits | null = ent.limits ? parseLimits(ent.limits) : null;
  if (ent.limits && Object.keys(limits ?? {}).length === 0) return { ok: false, error: "invalid_limits" };

  let created;
  try {
    created = await deps.create({
      name: input.organizationName,
      slug: input.slug,
      adminEmail: input.adminEmail,
      adminName: input.adminName,
      plan: ent.plan ?? "free",
      ...(limits ? { limits } : {}),
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === "slug_taken") return { ok: false, error: "slug_taken" };
    throw e;
  }

  // After the tenant exists, because the centre stores the link against it.
  // A failure here leaves a reachable workspace whose console cannot complete a
  // login yet -- worth warning about, never worth discarding the invite for.
  const linked = await deps.reportLink({
    organizationId: input.organizationId,
    tenantId: created.tenant.id,
    consoleOrigin,
  });

  return { ok: true, inviteUrl: created.inviteUrl, linked };
}
