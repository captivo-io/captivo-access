import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { db } from "@/lib/db";
import { getOidcConfig, getOidcSecret } from "@/lib/auth/oidc-config";
import { discover, checkClaims, accessGrant, accessGrantFor, accessRoleForGrant, type IdClaims } from "@/lib/auth/oidc";
import { centerRoleOf, reconcileCenterRole } from "@/lib/auth/center-role";
import { readAmr, secondFactorGate } from "@/lib/auth/amr";
import { getSessionPolicy } from "@/lib/policy/session-policy";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { readOidcState, clearOidcState } from "@/lib/auth/oidc-state";
import { startSession } from "@/lib/auth/session";
import { syncUserAtLogin } from "@/lib/directory/sync";
import { safeReturnTo } from "@/lib/auth/return-to";
import { managerBaseUrl } from "@/lib/url";
import { withTenantRoute } from "@/lib/tenant/request";
import { signWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { tenantSlugByOrg } from "@/lib/platform/sql";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { currentTenantId } from "@/lib/tenant/context";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { IDP_TIMEOUT_MS } from "@/lib/auth/oidc";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const dynamic = "force-dynamic";

// Redirect back to /login with a generic, user-safe error code. The specific
// `reason` is logged server-side only (never shown to the user) so an opaque
// `error=sso` can be diagnosed from the manager logs. The base is the manager's
// public URL (managerBaseUrl), NOT req.nextUrl — behind the proxy the latter
// resolves to the container's own hostname and sends the browser somewhere it
// can't reach.
function fail(req: NextRequest, error: string, reason?: string) {
  console.error(`[oidc] login failed (${error})${reason ? `: ${reason}` : ""}`);
  return NextResponse.redirect(new URL(`/login?error=${error}`, managerBaseUrl(req)));
}

async function handler(req: NextRequest) {
  const cfg = await getOidcConfig();
  const saved = await readOidcState();
  await clearOidcState(); // single-use, always cleared

  if (!cfg || !cfg.enabled) return fail(req, "sso", "sso_not_enabled");
  if (!saved) return fail(req, "sso", "no_saved_state (ca_oidc cookie missing/expired)");

  const params = req.nextUrl.searchParams;
  const idpError = params.get("error");
  if (idpError) return fail(req, "sso", `idp_returned_error: ${idpError} ${params.get("error_description") ?? ""}`.trim());
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || state !== saved.state) return fail(req, "sso", "missing_code_or_state_mismatch");

  let disc;
  try {
    disc = await discover(cfg.issuer);
  } catch (e) {
    return fail(req, "sso", `discover_failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const secret = await getOidcSecret();
  if (!secret) return fail(req, "sso", "no_client_secret_saved");

  const redirectUri = `${managerBaseUrl(req)}/api/auth/oidc/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: secret,
    code_verifier: saved.codeVerifier,
  });
  let tokens: { id_token?: string; access_token?: string };
  try {
    // Bounded: the token endpoint is the customer's IdP. Without a ceiling a
    // sign-in can hang indefinitely on it.
    const res = await fetchWithTimeout(disc.token_endpoint, {
      timeoutMs: IDP_TIMEOUT_MS,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(req, "sso", `token_endpoint_${res.status}: ${detail.slice(0, 300)}`);
    }
    tokens = await res.json();
  } catch (e) {
    return fail(req, "sso", `token_request_threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!tokens.id_token) return fail(req, "sso", "no_id_token_in_response");

  // Verify the ID token: signature (JWKS) + iss + aud + exp/nbf via jose.
  let claims: IdClaims;
  try {
    const JWKS = createRemoteJWKSet(new URL(disc.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      // Verify against the issuer the IdP declares in discovery — that is what
      // it stamps into `iss` (Auth0 keeps a trailing slash the config strips).
      issuer: disc.issuer,
      audience: cfg.clientId,
      algorithms: ["RS256", "ES256", "PS256"],
    });
    claims = payload as IdClaims;
  } catch (e) {
    return fail(req, "sso", `id_token_verify_failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Remaining claim checks (azp/nonce/email_verified) + email extraction.
  const checked = checkClaims(claims, { issuer: disc.issuer, clientId: cfg.clientId, nonce: saved.nonce });
  if (!checked.ok) return fail(req, "sso", `claim_check_failed: ${checked.reason}`);
  const email = checked.email;

  // The workspace's second-factor requirement, decided BEFORE anything is
  // provisioned or consumed below: an invite must not be spent, nor a
  // workspace offered, on a sign-in that is about to be refused.
  const amr = readAmr(claims);
  const gate = secondFactorGate({
    required: (await getSessionPolicy()).requireSecondFactor,
    amr,
    steppedUp: saved.stepUp === true,
  });
  if (gate === "step_up") {
    console.info("[oidc] no second factor in amr; asking the provider to re-authenticate");
    const again = new URL("/api/auth/oidc/start", managerBaseUrl(req));
    again.searchParams.set("stepUp", "1");
    again.searchParams.set("returnTo", saved.returnTo);
    return NextResponse.redirect(again);
  }
  if (gate === "refuse") {
    // The login page turns this into "turn two-step on in your Captivo
    // account" when the provider is ours; the address is logged so an operator
    // reading the manager log sees the same hint.
    return fail(req, "mfa_required", `amr=${JSON.stringify(amr)}${cfg.isPlatform ? ` account=${captivoAccountUrl()}` : ""}`);
  }

  // The organisation this tenant belongs to, when the platform's own provider
  // signed the token on a tenant console. Null everywhere else: a tenant IdP's
  // token knows nothing about Captivo organisations, and the platform host is
  // nobody's workspace.
  const onTenantConsole = cfg.isPlatform && currentTenantId() !== PLATFORM_TENANT_ID;
  const tenantOrg = onTenantConsole
    ? (await db.tenant.findUnique({ where: { id: currentTenantId() }, select: { captivoOrgId: true } }))?.captivoOrgId ?? null
    : null;

  // Provisioning (spec §5): existing ACTIVE user, else redeem an invite, else reject.
  let user = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (user) {
    // THE CENTRE'S WORD IS APPLIED AT EVERY SIGN-IN, not only the first
    // (lib/auth/center-role.ts). A user the centre manages whose grant for
    // this organisation is gone was removed there, so is refused and
    // disabled here; a role change there resets the console role.
    if (tenantOrg) {
      const grant = accessGrantFor(claims, tenantOrg);
      const verdict = reconcileCenterRole(user, grant ? grant.role : null);
      if (verdict.outcome === "revoked") {
        await db.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
        console.info(`[oidc] no grant for the tenant's organisation; member removed at the centre: ${user.id}`);
        return fail(req, "center_revoked");
      }
      if (verdict.outcome === "update") {
        const { role, centerRole, status } = verdict;
        console.info(`[oidc] console role follows the centre: ${user.id} ${user.role} -> ${role} (${centerRole})`);
        user = await db.user.update({ where: { id: user.id }, data: { role, centerRole, status } });
      }
    }
    if (user.status !== "ACTIVE") return fail(req, "disabled");
    const sync = await syncUserAtLogin({
      id: user.id,
      email: user.email,
      role: user.role,
      directoryManaged: user.directoryManaged,
    });
    if (sync.deprovisioned) return fail(req, "revoked");
    await startSession(user.id, req, amr);
    return NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), managerBaseUrl(req)));
  }

  const invite = await db.invite.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, usedAt: null, expiresAt: { gt: new Date() } },
  });
  // Third branch: an identity Captivo ID says is entitled to Access but that
  // has no user and no invite anywhere yet -- the case the free tier creates.
  // `!invite` is part of the condition, not just the comment: a platform
  // operator who was invited to the console AND holds an ACCESS grant was
  // being redirected to workspace creation on every sign-in and could never
  // accept their invite. A live invite always wins.
  // Offered ONLY on the platform host: a grant says what the organisation
  // bought, not that this person belongs to the tenant whose console they
  // happen to be standing on.
  if (!invite && currentTenantId() === PLATFORM_TENANT_ID) {
    const grant = accessGrant(claims);
    if (grant) {
      // A workspace this organisation ALREADY has is not something to create
      // again. Without this, someone arriving at the platform host was shown
      // the address form, typed an address they had already chosen, and was
      // told at the submit that it was taken -- by themselves. The manager's
      // own hosts comment claimed this forwarding existed; it did not.
      const existingSlug = await tenantSlugByOrg(grant.org);
      const domain = consoleDomain();
      if (existingSlug && domain) {
        return NextResponse.redirect(`https://${existingSlug}.${domain}`);
      }
      const secret = process.env.CAPTIVO_ID_CLIENT_SECRET ?? "";
      const token = signWorkspaceClaim(
        { org: grant.org, orgName: grant.orgName, email, name: claims.name },
        secret,
      );
      const res = NextResponse.redirect(new URL("/workspace/new", managerBaseUrl(req)));
      // Path "/" and not "/workspace": RFC 6265 path-matching would send a
      // "/workspace" cookie to /workspace/new but NOT to /api/workspace/create,
      // so the page rendered and the submit behind it answered 401 forever.
      // The endpoint clears it at the same path -- a mismatched clear leaves
      // the cookie behind.
      res.cookies.set("captivo_workspace", token, {
        httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 15 * 60,
      });
      return res;
    }
  }

  // Fourth branch, on a TENANT console: no user and no invite, but the token
  // carries an ACCESS grant for this tenant's own organisation -- someone an
  // owner invited into the organisation at Captivo ID. They belong here by
  // the organisation's word, with the role the organisation gave them; a
  // console invite on top would be the same question asked twice. Only the
  // platform's own identity provider can say this: a tenant IdP's token knows
  // nothing about Captivo organisations and carries no such claim.
  if (!invite && onTenantConsole) {
    const grant = tenantOrg ? accessGrantFor(claims, tenantOrg) : null;
    if (grant) {
      let joined;
      try {
        joined = await db.user.create({
          data: {
            email,
            name: claims.name || email.split("@")[0],
            role: accessRoleForGrant(grant.role),
            centerRole: centerRoleOf(grant.role),
            status: "ACTIVE",
          },
        });
      } catch (e) {
        return fail(req, "sso", `org_member_create_failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.info(`[oidc] organisation member joined tenant ${currentTenantId()} as ${joined.role}`);
      const sync = await syncUserAtLogin({
        id: joined.id,
        email: joined.email,
        role: joined.role,
        directoryManaged: joined.directoryManaged,
      });
      if (sync.deprovisioned) return fail(req, "revoked");
      await startSession(joined.id, req, amr);
      return NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), managerBaseUrl(req)));
    }
  }

  if (!invite) {
    // The reason matters more here than anywhere else in this handler: the
    // three ways to reach this line look identical from the browser, and the
    // first live occurrence -- an entitled person whose token carried no
    // grants because the authorization request never asked for the captivo
    // scope -- took hours to tell apart from "genuinely not invited". No
    // email is logged: the tenant and the shape of the miss are enough.
    const onPlatform = currentTenantId() === PLATFORM_TENANT_ID;
    return fail(
      req,
      "no_account",
      onPlatform
        ? "no user, no invite, and no ACCESS grant in the token (is the captivo scope requested and released?)"
        : `no user and no invite on tenant ${currentTenantId()}`,
    );
  }

  // Atomically consume the invite; a race (or a passkey enrollment in flight)
  // that already used it makes updateMany match 0 rows → bail.
  const consumed = await db.invite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
  if (consumed.count === 0) return fail(req, "no_account", "invite_already_consumed");

  let created;
  try {
    created = await db.user.create({
      data: {
        email: invite.email,
        name: invite.name || claims.name || email.split("@")[0],
        role: invite.role,
        status: "ACTIVE",
      },
    });
  } catch (e) {
    return fail(req, "sso", `user_create_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sync = await syncUserAtLogin({
    id: created.id,
    email: created.email,
    role: created.role,
    directoryManaged: created.directoryManaged,
  });
  if (sync.deprovisioned) return fail(req, "revoked");
  await startSession(created.id, req, amr);
  return NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), managerBaseUrl(req)));
}

// Waits on the customer's identity provider for the token exchange, so the tenant
// scope (a transaction) needs a budget that outlasts it -- see SLOW_SCOPE_BUDGET_MS.
export const GET = withTenantRoute(handler, { budgetMs: SLOW_SCOPE_BUDGET_MS });
