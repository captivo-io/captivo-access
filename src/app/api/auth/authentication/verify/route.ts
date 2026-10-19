import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/request-ip";
import { cookies } from "next/headers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { verifyAuthentication } from "@/lib/auth/webauthn";
import { readChallenge, clearChallenge } from "@/lib/auth/challenge";
import { db } from "@/lib/db";
import { createSession, sessionCookieMaxAgeSeconds, SESSION_COOKIE } from "@/lib/auth/session";
import { syncUserAtLogin } from "@/lib/directory/sync";
import { cookieSecure, cookieDomain } from "@/lib/auth/cookies";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRpId, originMatchesRp, requestOrigin } from "@/lib/auth/rp";
import { withTenantRoute } from "@/lib/tenant/request";
import { passkeyAmr, secondFactorGate } from "@/lib/auth/amr";
import { getSessionPolicy } from "@/lib/policy/session-policy";

function requestMeta(req: NextRequest) {
  return {
    userAgent: req.headers.get("user-agent") ?? undefined,
    ip: clientIp(req.headers) ?? undefined,
  };
}

async function handler(req: NextRequest) {
  const ip = clientIp(req.headers) ?? "unknown";
  const key = `${ip}:${new URL(req.url).pathname}`;
  if (!checkRateLimit(key, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!response?.id) {
    return NextResponse.json({ error: "invalid_body" }, { status: 401 });
  }

  const expectedChallenge = await readChallenge("auth");
  if (!expectedChallenge) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 401 });
  }

  const passkey = await db.passkey.findFirst({ where: { credentialId: response.id }, include: { user: true } });
  if (!passkey || passkey.user.status !== "ACTIVE") {
    return NextResponse.json({ error: "verification_failed" }, { status: 401 });
  }

  const origin = requestOrigin(req);
  if (!originMatchesRp(origin, getRpId())) {
    return NextResponse.json({ error: "origin_mismatch" }, { status: 400 });
  }

  let result;
  try {
    result = await verifyAuthentication(response, expectedChallenge, origin, {
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      counter: Number(passkey.counter),
      transports: passkey.transports,
    });
  } catch {
    return NextResponse.json({ error: "verification_failed" }, { status: 401 });
  }
  if (!result.verified) {
    return NextResponse.json({ error: "verification_failed" }, { status: 401 });
  }

  await db.passkey.update({
    where: { id: passkey.id },
    data: { counter: BigInt(result.authenticationInfo.newCounter), lastUsedAt: new Date() },
  });

  // The workspace's second-factor requirement. A passkey that verified the
  // person (PIN, fingerprint, face) is two factors; a bare possession is not.
  // There is no provider to ask again, so this is the final answer.
  const amr = passkeyAmr(result.authenticationInfo.userVerified);
  const gate = secondFactorGate({ required: (await getSessionPolicy()).requireSecondFactor, amr, steppedUp: true });
  if (gate !== "allow") {
    return NextResponse.json({ error: "mfa_required" }, { status: 403 });
  }

  // AD group sync (JIT): reconcile role/grants; reject if deprovisioned. Fail-open inside.
  const sync = await syncUserAtLogin({
    id: passkey.user.id,
    email: passkey.user.email,
    role: passkey.user.role,
    directoryManaged: passkey.user.directoryManaged,
  });
  if (sync.deprovisioned) {
    return NextResponse.json({ error: "revoked" }, { status: 403 });
  }

  const token = await createSession(passkey.userId, { ...requestMeta(req), amr });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: await cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: await sessionCookieMaxAgeSeconds(),
    domain: cookieDomain(),
  });
  await clearChallenge();

  return NextResponse.json({ ok: true });
}

export const POST = withTenantRoute(handler);
