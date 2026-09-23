import { base } from "@/lib/db";
import { withTenant } from "@/lib/tenant/scope";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { PLATFORM_TENANT_ID, isValidTenantSlug, isReservedSlug } from "@/lib/tenant/constants";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { getPlatformConfig } from "@/lib/platform/config";
import { createTenant, PlatformError } from "@/lib/platform/tenants";
import { recordPlatformAction } from "@/lib/platform/audit";
import { registerWithCaptivoId } from "@/lib/auth/captivo-id-register";
import { sendMail } from "@/lib/email/mailer";
import { normalizeEmail } from "@/lib/auth/email";
import { normalizeDisplayName } from "@/lib/auth/display-name";
import { signSignup, verifySignup, type SignupClaims } from "./token";

export async function signupEnabled(): Promise<boolean> {
  return multiTenantEnabled() && (await getPlatformConfig()).signupEnabled;
}

export async function slugAvailable(slug: string): Promise<boolean> {
  if (!isValidTenantSlug(slug) || isReservedSlug(slug)) return false;
  const rows = await base.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM platform_list_tenants() WHERE slug = $1`, slug);
  return rows.length === 0;
}

// Step 1: validate + email the verification link (sent via the platform tenant's SMTP).
export async function startSignup(input: { name: string; slug: string; email: string; adminName: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const email = normalizeEmail(input.email);
  const adminName = normalizeDisplayName(input.adminName) ?? "";
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "invalid_email" };
  if (!(await slugAvailable(slug))) return { ok: false, error: "slug_taken" };
  const domain = consoleDomain();
  if (!domain) return { ok: false, error: "unavailable" };
  const token = await signSignup({ name, slug, email, adminName });
  const link = `https://platform.${domain}/api/signup/verify?t=${encodeURIComponent(token)}`;
  const sent = await withTenant(PLATFORM_TENANT_ID, () =>
    sendMail({
      to: email,
      subject: `Confirm your Captivo Access workspace: ${slug}`,
      text: `Confirm your email to create the "${name}" workspace at https://${slug}.${domain}\n\n${link}\n\nThe link is valid for 30 minutes. If you did not request this, ignore this email.`,
      html: `<p>Confirm your email to create the <b>${escapeHtml(name)}</b> workspace at <code>${slug}.${domain}</code>.</p><p><a href="${link}">Create my workspace</a></p><p>The link is valid for 30 minutes. If you did not request this, ignore this email.</p>`,
    }),
  );
  if (!sent.sent) return { ok: false, error: "mail_failed" };
  return { ok: true };
}

// Step 2: the verified link creates the trial tenant and hands the invite over.
export async function completeSignup(token: string): Promise<{ ok: true; inviteUrl: string } | { ok: false; error: string }> {
  const c: SignupClaims | null = await verifySignup(token);
  if (!c) return { ok: false, error: "invalid_token" };
  let result;
  try {
    // The FREE tier, not a timed trial. Both doors into Access now give the
    // same thing: a workspace that does not expire, capped at the free
    // allowance. Someone who needs more buys more; nobody loses a workspace
    // because a clock ran out. The caps are spelled here rather than imported
    // from the centre because this path does not go through the centre's gift
    // policy -- see lib/platform/plan-usage.ts for where they are shown.
    result = await createTenant({ name: c.name, slug: c.slug, adminEmail: c.email, adminName: c.adminName || undefined, plan: "free", limits: { maxConnectors: 1, maxSites: 5 } });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.code };
    throw e;
  }
  await withTenant(PLATFORM_TENANT_ID, () =>
    recordPlatformAction({ actor: { id: "signup", email: c.email }, action: "platform.tenant.signup", tenant: { id: result.tenant.id, slug: result.tenant.slug }, summary: `Self-service signup created free-tier tenant ${c.slug} for ${c.email}`, metadata: { plan: "free" } }),
  );
  // Best-effort: one Captivo account should reach both products, but the
  // workspace above already exists and the customer is waiting on their
  // invite link -- a problem registering with Captivo ID must never undo
  // that. See registerWithCaptivoId for why failures only get logged.
  await registerWithCaptivoId({ email: c.email, organizationName: c.name, name: c.adminName || c.name });
  return { ok: true, inviteUrl: result.inviteUrl };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
