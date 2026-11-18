import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { cookieSecure } from "./cookies";

// Short-lived, jose-signed cookie for the TOTP recovery flow — mirrors the
// pattern in challenge.ts. `/api/auth/recover` sets this cookie after
// verifying email+TOTP; registration mode:"recover" requires it (to add
// a new Passkey to an existing user).
const COOKIE = "ca_recover";

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required");
  return new TextEncoder().encode(s);
}

/** `resetId` binds the cookie to an admin-issued reset link, consumed when the new passkey is saved. */
export async function setRecoverToken(userId: string, resetId?: string): Promise<void> {
  const jwt = await new SignJWT({ userId, purpose: "recover", ...(resetId ? { resetId } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, { httpOnly: true, secure: await cookieSecure(), sameSite: "lax", maxAge: 600, path: "/" });
}

export async function readRecoverToken(): Promise<string | null> {
  return (await readRecoverClaims())?.userId ?? null;
}

export async function readRecoverClaims(): Promise<{ userId: string; resetId: string | null } | null> {
  const c = (await cookies()).get(COOKIE)?.value;
  if (!c) return null;
  try {
    const { payload } = await jwtVerify(c, secret());
    if (payload.purpose !== "recover" || typeof payload.userId !== "string") return null;
    return { userId: payload.userId, resetId: typeof payload.resetId === "string" ? payload.resetId : null };
  } catch {
    return null;
  }
}

export async function clearRecoverToken(): Promise<void> {
  (await cookies()).delete({ name: COOKIE, path: "/" });
}
