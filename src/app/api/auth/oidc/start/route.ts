import { NextRequest, NextResponse } from "next/server";
import { getOidcConfig } from "@/lib/auth/oidc-config";
import { discover, randomUrlSafe, codeChallengeS256 } from "@/lib/auth/oidc";
import { setOidcState } from "@/lib/auth/oidc-state";
import { safeReturnTo } from "@/lib/auth/return-to";
import { managerBaseUrl } from "@/lib/url";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  const cfg = await getOidcConfig();
  // Browser redirects use managerBaseUrl (the public URL), NOT req.nextUrl —
  // behind the proxy the latter resolves to the container's own hostname.
  const base = managerBaseUrl(req);
  if (!cfg || !cfg.enabled) return NextResponse.redirect(new URL("/login", base));

  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const codeVerifier = randomUrlSafe(64);

  let authorizationEndpoint: string;
  try {
    authorizationEndpoint = (await discover(cfg.issuer)).authorization_endpoint;
  } catch (e) {
    console.error(`[oidc] start failed (sso): discover_failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.redirect(new URL("/login?error=sso", base));
  }

  await setOidcState({ state, nonce, codeVerifier, returnTo });

  const redirectUri = `${managerBaseUrl(req)}/api/auth/oidc/callback`;
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return NextResponse.redirect(url);
}

export const GET = withTenantRoute(handler);
