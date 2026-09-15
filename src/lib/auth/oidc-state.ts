import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { cookieDomain } from "./cookies";
import { cookieSecure } from "./cookies";

const COOKIE = "ca_oidc";
const TTL_SECONDS = 600; // 10 minutes to complete the round trip

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required");
  return new TextEncoder().encode(s);
}

type OidcState = { state: string; nonce: string; codeVerifier: string; returnTo: string };

/**
 * Store the in-flight OIDC state.
 *
 * `shareAcrossConsoles` widens the cookie to COOKIE_DOMAIN, and it is needed
 * for exactly one case: the PLATFORM provider sends the browser back to a
 * single fixed console host, while the person started on their own tenant's
 * subdomain. A host-only cookie is unreadable there, and the callback fails
 * with "no saved state" -- which is what happened the first time this was
 * wired up, in a browser, after curl had reported the flow working as far as
 * the code.
 *
 * It stays host-only for a tenant's OWN provider, because that flow returns to
 * the same host it started on and the narrower scope is the safer default.
 */
export async function setOidcState(data: OidcState, shareAcrossConsoles = false): Promise<void> {
  const jwt = await new SignJWT({ ...data })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true,
    secure: await cookieSecure(),
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/",
    ...(shareAcrossConsoles ? { domain: cookieDomain() } : {}),
  });
}

export async function readOidcState(): Promise<OidcState | null> {
  const c = (await cookies()).get(COOKIE)?.value;
  if (!c) return null;
  try {
    const { payload } = await jwtVerify(c, secret());
    const { state, nonce, codeVerifier, returnTo } = payload as Record<string, unknown>;
    if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string" || typeof returnTo !== "string") {
      return null;
    }
    return { state, nonce, codeVerifier, returnTo };
  } catch {
    return null;
  }
}

export async function clearOidcState(): Promise<void> {
  // BOTH scopes. A cookie is identified by name+domain+path, so deleting the
  // host-only one leaves a domain-scoped one in place and vice versa -- and a
  // leftover state cookie makes the NEXT sign-in read a stale code_verifier
  // and fail in a way that looks like a broken provider.
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/" });
  const d = cookieDomain();
  if (d) jar.delete({ name: COOKIE, path: "/", domain: d });
}
