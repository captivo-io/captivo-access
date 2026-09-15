import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { db } from "@/lib/db";
import { getOidcConfig, getOidcSecret } from "@/lib/auth/oidc-config";
import { discover, checkClaims, type IdClaims } from "@/lib/auth/oidc";
import { readOidcState, clearOidcState } from "@/lib/auth/oidc-state";
import { startSession } from "@/lib/auth/session";
import { syncUserAtLogin } from "@/lib/directory/sync";
import { safeReturnTo } from "@/lib/auth/return-to";
import { managerBaseUrl } from "@/lib/url";
import { callbackOrigin } from "@/lib/auth/oidc-source";
import { withTenantRoute } from "@/lib/tenant/request";

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

  // Exchange the code (PKCE + client_secret_post).
  // MUST match the value the start route sent, byte for byte: the provider
  // compares them and refuses the exchange otherwise.
  const redirectUri = `${callbackOrigin(
    cfg.isPlatform ? { kind: "platform", config: { issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: "" } } : { kind: "tenant" },
    managerBaseUrl(req),
    process.env.MANAGER_PUBLIC_URL,
  )}/api/auth/oidc/callback`;
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
    const res = await fetch(disc.token_endpoint, {
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

  // Provisioning (spec §5): existing ACTIVE user, else redeem an invite, else reject.
  const user = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (user) {
    if (user.status !== "ACTIVE") return fail(req, "disabled");
    const sync = await syncUserAtLogin({
      id: user.id,
      email: user.email,
      role: user.role,
      directoryManaged: user.directoryManaged,
    });
    if (sync.deprovisioned) return fail(req, "revoked");
    await startSession(user.id, req);
    return NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), managerBaseUrl(req)));
  }

  const invite = await db.invite.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!invite) return fail(req, "no_account");

  // Atomically consume the invite; a race (or a passkey enrollment in flight)
  // that already used it makes updateMany match 0 rows → bail.
  const consumed = await db.invite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
  if (consumed.count === 0) return fail(req, "no_account");

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
  await startSession(created.id, req);
  return NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), managerBaseUrl(req)));
}

export const GET = withTenantRoute(handler);
