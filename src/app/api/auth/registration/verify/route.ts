import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/request-ip";
import { cookies } from "next/headers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { verifyRegistration } from "@/lib/auth/webauthn";
import { readChallenge, readChallengeUid, clearChallenge } from "@/lib/auth/challenge";
import { db } from "@/lib/db";
import { createSession, sessionCookieMaxAgeSeconds, SESSION_COOKIE } from "@/lib/auth/session";
// Recorded, not gated: accepting an invite or recovering an account is not a
// sign-in to an existing session policy; the next sign-in is.
import { passkeyAmr } from "@/lib/auth/amr";
import { cookieSecure, cookieDomain } from "@/lib/auth/cookies";
import { hasAnyUser } from "@/lib/auth/bootstrap";
import { verifyInvite } from "@/lib/auth/invite";
import { normalizeDisplayName } from "@/lib/auth/display-name";
import { readRecoverToken, clearRecoverToken } from "@/lib/auth/recover-token";
import { getCurrentUser } from "@/lib/current-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRpId, originMatchesRp, requestOrigin } from "@/lib/auth/rp";
import { normalizeEmail } from "@/lib/auth/email";
import { resolveSetupRole } from "@/lib/auth/setup-role";
import { withTenantRoute } from "@/lib/tenant/request";

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
  const mode = body.mode;

  if (mode === "add") {
    const user = await getCurrentUser();
    const response = body.response as RegistrationResponseJSON | undefined;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!response || !label) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const expectedChallenge = await readChallenge("reg");
    if (!expectedChallenge) {
      return NextResponse.json({ error: "challenge_expired" }, { status: 401 });
    }

    const origin = requestOrigin(req);
    if (!originMatchesRp(origin, getRpId())) {
      return NextResponse.json({ error: "origin_mismatch" }, { status: 400 });
    }

    const result = await verifyRegistration(response, expectedChallenge, origin);
    if (!result.verified || !result.registrationInfo) {
      return NextResponse.json({ error: "verification_failed" }, { status: 401 });
    }
    const { credential } = result.registrationInfo;

    // Already logged in — no new Session is CREATED, only the Passkey is added.
    await db.passkey.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter ?? 0),
        transports: credential.transports ?? [],
        label,
      },
    });
    await clearChallenge();

    return NextResponse.json({ ok: true });
  }
  if (mode === "recover") {
    const userId = await readRecoverToken();
    const response = body.response as RegistrationResponseJSON | undefined;
    if (!userId || !response) {
      return NextResponse.json({ error: "recover_invalid" }, { status: 401 });
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE") {
      return NextResponse.json({ error: "recover_invalid" }, { status: 401 });
    }

    const expectedChallenge = await readChallenge("reg");
    if (!expectedChallenge) {
      return NextResponse.json({ error: "challenge_expired" }, { status: 401 });
    }

    const origin = requestOrigin(req);
    if (!originMatchesRp(origin, getRpId())) {
      return NextResponse.json({ error: "origin_mismatch" }, { status: 400 });
    }

    const result = await verifyRegistration(response, expectedChallenge, origin);
    if (!result.verified || !result.registrationInfo) {
      return NextResponse.json({ error: "verification_failed" }, { status: 401 });
    }
    const { credential } = result.registrationInfo;

    // A NEW passkey is added to the existing user — no new User is CREATED.
    await db.passkey.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter ?? 0),
        transports: credential.transports ?? [],
        label: "Recovery passkey",
      },
    });

    const token = await createSession(user.id, { ...requestMeta(req), amr: passkeyAmr(result.registrationInfo.userVerified) });
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: await cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: await sessionCookieMaxAgeSeconds(),
      domain: cookieDomain(),
    });
    await clearChallenge();
    await clearRecoverToken();

    return NextResponse.json({ ok: true });
  }
  if (mode === "invite") {
    const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken : "";
    const response = body.response as RegistrationResponseJSON | undefined;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Primary passkey";
    if (!inviteToken || !response) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    // Re-verify at registration time: the invite may have been used or
    // expired since the options call.
    const invite = await verifyInvite(inviteToken);
    if (!invite) {
      return NextResponse.json({ error: "invite_invalid" }, { status: 410 });
    }
    // Display name confirmed on the enrollment form; the invite's when omitted.
    if (body.name !== undefined && normalizeDisplayName(body.name) === null) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    const displayName = normalizeDisplayName(body.name) ?? invite.name;

    const expectedChallenge = await readChallenge("reg");
    if (!expectedChallenge) {
      return NextResponse.json({ error: "challenge_expired" }, { status: 401 });
    }

    const origin = requestOrigin(req);
    if (!originMatchesRp(origin, getRpId())) {
      return NextResponse.json({ error: "origin_mismatch" }, { status: 400 });
    }

    const result = await verifyRegistration(response, expectedChallenge, origin);
    if (!result.verified || !result.registrationInfo) {
      return NextResponse.json({ error: "verification_failed" }, { status: 401 });
    }
    const { credential } = result.registrationInfo;

    // The uid generated during the options step was embedded in the resident
    // credential as the WebAuthn userHandle — User.id must take the same
    // value here, otherwise userHandle != User.id (see the note in
    // registration/options/route.ts).
    const uid = await readChallengeUid("reg");

    let userId: string;
    try {
      // User + Passkey + invite-consumption in a single transaction: if one
      // fails, none of it is committed (this also prevents a double-enroll
      // race — the conditional update in invite.updateMany({ id, usedAt: null })
      // ensures only one of two concurrent verifies gets count:1; the other
      // sees count:0, throws INVITE_ALREADY_USED, and the transaction rolls
      // back, so neither User gets committed).
      const user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            ...(uid ? { id: uid } : {}),
            email: invite.email,
            name: displayName,
            role: invite.role,
            phone: invite.phone,
            company: invite.company,
            status: "ACTIVE",
          },
        });
        await tx.passkey.create({
          data: {
            userId: created.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: BigInt(credential.counter ?? 0),
            transports: credential.transports ?? [],
            label,
          },
        });
        const consumed = await tx.invite.updateMany({
          where: { id: invite.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (consumed.count === 0) {
          throw new Error("INVITE_ALREADY_USED");
        }
        return created;
      });
      userId = user.id;
    } catch (err) {
      if (err instanceof Error && err.message === "INVITE_ALREADY_USED") {
        return NextResponse.json({ error: "invite_invalid" }, { status: 410 });
      }
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }

    const token = await createSession(userId, { ...requestMeta(req), amr: passkeyAmr(result.registrationInfo.userVerified) });
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
  if (mode !== "setup") {
    return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const response = body.response as RegistrationResponseJSON | undefined;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Primary passkey";
  if (!email || !name || !response) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const expectedChallenge = await readChallenge("reg");
  if (!expectedChallenge) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 401 });
  }

  const origin = requestOrigin(req);
  if (!originMatchesRp(origin, getRpId())) {
    return NextResponse.json({ error: "origin_mismatch" }, { status: 400 });
  }

  const result = await verifyRegistration(response, expectedChallenge, origin);
  if (!result.verified || !result.registrationInfo) {
    return NextResponse.json({ error: "verification_failed" }, { status: 401 });
  }
  const { credential } = result.registrationInfo;

  // Race guard: someone else may have completed setup during the time
  // between the options call and verify. A small window still remains
  // between this check and create (a full lock would require a unique
  // constraint + a single-row "setup lock" table), but in practice this
  // prevents two concurrent setups from both creating an ADMIN.
  const setup = resolveSetupRole();
  if (!setup.allowed) {
    return NextResponse.json({ error: "setup_disabled" }, { status: 404 });
  }
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_setup" }, { status: 409 });
  }

  // The uid generated during the options step was embedded in the resident
  // credential as the WebAuthn userHandle — User.id must take the same
  // value here, otherwise userHandle != User.id (see the note in
  // registration/options/route.ts).
  const uid = await readChallengeUid("reg");

  let userId: string;
  try {
    // Creating the User + Passkey in a single DB transaction: if one fails,
    // the other is rolled back too (no "locked" ADMIN without a passkey).
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { ...(uid ? { id: uid } : {}), email, name, role: setup.role, status: "ACTIVE" },
      });
      await tx.passkey.create({
        data: {
          userId: created.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter ?? 0),
          transports: credential.transports ?? [],
          label,
        },
      });
      return created;
    });
    userId = user.id;
  } catch {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const token = await createSession(userId, { ...requestMeta(req), amr: passkeyAmr(result.registrationInfo.userVerified) });
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
