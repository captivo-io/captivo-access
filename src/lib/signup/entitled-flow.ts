/**
 * Creating the workspace an entitled identity is owed.
 *
 * This is the counterpart to flow.ts. That one starts from an email nobody has
 * verified and proves the address before creating anything; this one starts
 * from a Captivo ID token that already carries a verified identity and an
 * entitlement, so what it has to establish is different: that the entitlement
 * is real (asked of the centre, never inferred from the token) and has not
 * lapsed, that the organisation does not already hold a workspace, and that the
 * address the workspace will live at can actually be formed.
 *
 * The dependencies are injected so the decisions can be tested without a
 * database, an RLS bootstrap or a live identity service.
 */

import { parseLimits, type TenantLimits } from "@/lib/platform/tenant-shape";
import type { EntitlementLookup } from "@/lib/auth/captivo-id-client";

export interface EntitledDeps {
  fetchEntitlement: (organizationId: string) => Promise<EntitlementLookup>;
  /** The workspace this organisation already has, or null. */
  findWorkspaceForOrg: (organizationId: string) => Promise<{ slug: string } | null>;
  create: (input: { name: string; slug: string; adminEmail: string; adminName?: string; plan?: string; limits?: TenantLimits; captivoOrgId?: string }) => Promise<{ tenant: { id: string; slug: string }; inviteUrl: string }>;
  reportLink: (input: { organizationId: string; tenantId: string; consoleOrigin: string }) => Promise<boolean>;
  consoleOriginFor: (slug: string) => string | null;
  /** Injected so the expiry decision does not depend on wall time in tests. */
  now?: () => Date;
}

export type ProvisionResult =
  | { ok: true; inviteUrl: string; linked: boolean }
  | { ok: false; error: string; existingSlug?: string };

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
): Promise<ProvisionResult> {
  // The entitlement is the authorisation, and it is ASKED OF THE CENTRE rather
  // than read from the token: the token says who this is, the centre says what
  // they bought, and those are different questions.
  const ent = await deps.fetchEntitlement(input.organizationId);
  // A centre that did not answer has not said "no". Reporting it as
  // not_entitled tells someone holding a valid grant something untrue and
  // unactionable; reporting it separately lets them be asked to retry. Either
  // way nothing is created -- silence never provisions.
  if (ent.status === "unavailable") return { ok: false, error: "centre_unavailable" };
  if (ent.status === "none") return { ok: false, error: "not_entitled" };

  // An entitlement that has lapsed is not an entitlement. An expiry we cannot
  // parse is not the same as no expiry either -- it means we do not know
  // whether the grant is still live, so it is refused rather than read as
  // "never expires".
  if (ent.expiresAt !== null) {
    const expiresAt = new Date(ent.expiresAt).getTime();
    const now = (deps.now ?? (() => new Date()))().getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= now) return { ok: false, error: "entitlement_expired" };
  }

  // One workspace per organisation. Without this the person still has no user
  // and no invite in the platform tenant after provisioning, so the next
  // sign-in walks the same branch and mints another free-tier workspace --
  // each with its own connector allowance. The unique index on
  // Tenant.captivoOrgId is the backstop; this check is what produces an answer
  // the person can act on.
  const existing = await deps.findWorkspaceForOrg(input.organizationId);
  if (existing) return { ok: false, error: "already_provisioned", existingSlug: existing.slug };

  // Formed before anything is created: a workspace at an address we cannot
  // build is a workspace nobody can reach.
  const consoleOrigin = deps.consoleOriginFor(input.slug);
  if (!consoleOrigin) return { ok: false, error: "no_console_domain" };

  // The centre's JSON is run through the same validator the console uses, so
  // unknown keys and junk are dropped rather than trusted. But dropping
  // EVERYTHING is not the same as "no caps were meant": caps that arrived and
  // did not survive validation would leave an uncapped free workspace, which is
  // the one outcome the tier cannot afford.
  //
  // This is why an explicitly empty object is refused like junk: absent caps
  // mean "no caps intended" and are legitimate, whereas an empty object means
  // caps WERE intended and did not survive the trip -- far likelier a bug at
  // the centre than a deliberate "uncapped free tier". Do not "fix" this by
  // letting {} through.
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
      captivoOrgId: input.organizationId,
      ...(limits ? { limits } : {}),
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === "slug_taken") return { ok: false, error: "slug_taken" };
    // The unique index fired between the check above and this insert. Same
    // answer as the check, minus the slug -- the row that won the race is not
    // in hand here.
    if (code === "org_taken") return { ok: false, error: "already_provisioned" };
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
