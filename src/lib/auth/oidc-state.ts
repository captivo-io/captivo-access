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

export async function setOidcState(data: OidcState): Promise<void> {
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
  // Both scopes: an install that ran the short-lived build which widened this
  // cookie may still have a domain-scoped one in the browser, and a leftover
  // state cookie makes the NEXT sign-in read a stale verifier.
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/" });
  const d = cookieDomain();
  if (d) jar.delete({ name: COOKIE, path: "/", domain: d });
}
