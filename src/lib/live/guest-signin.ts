import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { jwtVerify, createRemoteJWKSet, customFetch } from "jose";
import { currentTenantId } from "@/lib/tenant/context";
import { tenantFetch } from "@/lib/net/guarded-fetch";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { discover, checkClaims, codeChallengeS256, randomUrlSafe, IDP_TIMEOUT_MS, type IdClaims } from "@/lib/auth/oidc";
import { guestProvider } from "./guest-provider";
import { readAmr, secondFactorGate } from "@/lib/auth/amr";
import { setOidcState } from "@/lib/auth/oidc-state";
import { cookieSecure } from "@/lib/auth/cookies";
import { managerBaseUrl } from "@/lib/url";
import { resolvedGuestRequireSecondFactor } from "@/lib/settings/platform";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { GUEST_COOKIE, guestPass, guestViewerId, newSecret } from "./invite-token";
import { consumeLink, openLink } from "./invites";

// A guest's sign-in, with the provider lib/live/guest-provider.ts picks. It shares the console's redirect URI (/api/auth/oidc/callback), the one
// registered with the provider; the state cookie's `guest` field routes the
// return here. Nothing in it starts a console session.

function joinPage(req: NextRequest, token: string, error?: string): NextResponse {
  const u = new URL(`/join/${encodeURIComponent(token)}`, managerBaseUrl(req));
  if (error) u.searchParams.set("error", error);
  return NextResponse.redirect(u);
}

/** Send the guest to the provider, asking for the invited address. */
export async function startGuestSignIn(req: NextRequest, token: string, stepUp: boolean): Promise<NextResponse> {
  const open = await openLink(token);
  if (!open.ok) return joinPage(req, token);
  const p = await guestProvider();
  if (!p) return joinPage(req, token, "no_provider");
  let disc;
  try {
    disc = await discover(p.issuer, p.trusted);
  } catch (e) {
    console.error(`[join] discover failed: ${e instanceof Error ? e.message : String(e)}`);
    return joinPage(req, token, "sso");
  }
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const codeVerifier = randomUrlSafe(64);
  await setOidcState({ state, nonce, codeVerifier, returnTo: "/join/watch", stepUp, guest: token });
  const url = new URL(disc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", `${managerBaseUrl(req)}/api/auth/oidc/callback`);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("ui_locales", "en");
  url.searchParams.set("login_hint", open.link.invite.email);
  // Always a fresh sign-in: someone else's account already signed in on this
  // browser must not join under the invited address's link.
  url.searchParams.set("prompt", "login");
  return NextResponse.redirect(url);
}

/** The provider's return for a guest: check who it is, spend the link, hand out the pass. */
export async function finishGuestSignIn(req: NextRequest, saved: { state: string; nonce: string; codeVerifier: string; stepUp?: boolean; guest: string }): Promise<NextResponse> {
  const token = saved.guest;
  const fail = (error: string, reason: string) => {
    console.error(`[join] guest sign-in failed (${error}): ${reason}`);
    return joinPage(req, token, error);
  };
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail("sso", `idp_returned_error: ${params.get("error")}`);
  const code = params.get("code");
  if (!code || params.get("state") !== saved.state) return fail("sso", "missing_code_or_state_mismatch");

  const open = await openLink(token);
  if (!open.ok) return joinPage(req, token);
  const p = await guestProvider();
  if (!p) return fail("no_provider", "no provider");

  let claims: IdClaims;
  let disc;
  try {
    disc = await discover(p.issuer, p.trusted);
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, client_id: p.clientId, client_secret: p.clientSecret,
      redirect_uri: `${managerBaseUrl(req)}/api/auth/oidc/callback`, code_verifier: saved.codeVerifier,
    });
    const init = { timeoutMs: IDP_TIMEOUT_MS, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body };
    const res = p.trusted ? await fetchWithTimeout(disc.token_endpoint, init) : await tenantFetch(disc.token_endpoint, init);
    if (!res.ok) return fail("sso", `token_endpoint_${res.status}`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) return fail("sso", "no_id_token");
    const JWKS = p.trusted
      ? createRemoteJWKSet(new URL(disc.jwks_uri))
      : createRemoteJWKSet(new URL(disc.jwks_uri), {
          [customFetch]: (url: string, opts: { headers?: Headers }) => tenantFetch(url, { timeoutMs: IDP_TIMEOUT_MS, headers: Object.fromEntries(new Headers(opts?.headers).entries()) }),
        });
    const { payload } = await jwtVerify(tokens.id_token, JWKS, { issuer: disc.issuer, audience: p.clientId, algorithms: ["RS256", "ES256", "PS256"] });
    claims = payload as IdClaims;
  } catch (e) {
    return fail("sso", `exchange_or_verify_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const checked = checkClaims(claims, { issuer: disc.issuer, clientId: p.clientId, nonce: saved.nonce });
  if (!checked.ok) return fail(checked.reason === "email_verified" ? "email_unverified" : "sso", `claim_check_failed: ${checked.reason}`);
  if (checked.email !== open.link.invite.email.toLowerCase()) return fail("wrong_account", "signed in under another address");

  const gate = secondFactorGate({ required: await resolvedGuestRequireSecondFactor(), amr: readAmr(claims), steppedUp: saved.stepUp === true });
  if (gate === "step_up") {
    const again = new URL("/api/join/start", managerBaseUrl(req));
    again.searchParams.set("t", token);
    again.searchParams.set("stepUp", "1");
    return NextResponse.redirect(again);
  }
  if (gate === "refuse") return fail("mfa_required", "no second factor");

  const subject = typeof (claims as Record<string, unknown>).sub === "string" ? ((claims as Record<string, unknown>).sub as string) : "";
  const name = (claims.name ?? "").trim() || checked.email;
  const secret = newSecret();
  if (!(await consumeLink(open.link.invite.id, { name, subject }, secret))) return joinPage(req, token);

  await recordAdminAction({
    actor: { id: guestViewerId(open.link.invite.id), email: checked.email },
    action: "session_invite.join",
    targetType: "session_invite",
    targetId: open.link.invite.id,
    summary: `${name} (${checked.email}) joined a live session on ${open.link.siteName} as an invited guest`,
    metadata: { sessionId: open.link.session.sessionId, siteId: open.link.session.siteId, canControl: open.link.invite.canControl, invitedBy: open.link.invite.createdByEmail },
    clientIp: clientIp(req.headers) ?? null,
  });

  (await cookies()).set(GUEST_COOKIE, guestPass(currentTenantId(), open.link.invite.id, secret), {
    httpOnly: true,
    secure: await cookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: open.link.invite.expiresAt,
  });
  return NextResponse.redirect(new URL("/join/watch", managerBaseUrl(req)));
}
