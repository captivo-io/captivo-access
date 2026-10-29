import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { hasAnyUser } from "@/lib/auth/bootstrap";
import { safeReturnTo } from "@/lib/auth/return-to";
import { getOidcConfig } from "@/lib/auth/oidc-config";
import { resolveSetupRole } from "@/lib/auth/setup-role";
import { LoginForm } from "./login-form";
import { AuthShell } from "@/components/auth-shell";
import { withRequestTenant } from "@/lib/tenant/request";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";

// getCurrentUser() must be read fresh from the DB on every request.
export const dynamic = "force-dynamic";

async function LoginPageImpl({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[]; error?: string | string[] }>;
}) {
  if (await getCurrentUser()) redirect("/");
  // First-run: with no users yet, there is nothing to log in to — send the
  // operator to the first-admin setup wizard instead of a dead-end login page.
  //
  // ONLY WHERE FIRST-RUN IS ALLOWED. On a cloud tenant console it is not:
  // tenant admins arrive by invitation, and the registration endpoints refuse
  // a tenant host outright. Redirecting there anyway made a freshly
  // provisioned workspace unreachable — its console has an invited admin but
  // no user yet, so /login bounced to a wizard whose form can never succeed,
  // and the SSO button that WOULD have let the invited admin in was on the
  // page nobody could reach.
  if (!(await hasAnyUser()) && resolveSetupRole().allowed) redirect("/setup");

  const sp = await searchParams;
  const returnTo = safeReturnTo(typeof sp.returnTo === "string" ? sp.returnTo : null);
  const sso = await getOidcConfig();
  const ssoEnabled = sso?.enabled ?? false;
  const ssoLabel = sso?.buttonLabel || "Sign in with SSO";
  const errorCode = typeof sp.error === "string" ? sp.error : null;
  const errorMsg =
    errorCode === "disabled" ? "Your account is disabled — contact an administrator."
    : errorCode === "no_account" ? "No account for that identity — ask an administrator to invite you."
    : errorCode === "sso" ? "Sign-in with your identity provider failed. Please try again."
    : errorCode === "support" ? "This support link is invalid, expired or already used. Open the tenant again from the platform console."
    : errorCode === "revoked" ? "Your access has been revoked — you are no longer a member of an authorized directory group."
    : errorCode === "center_revoked" ? "Your access has been revoked — you are no longer a member of this workspace's Captivo organisation."
    : errorCode === "email_unverified" && sso?.isPlatform === true ? unverifiedMessage(captivoAccountUrl())
    : errorCode === "mfa_required" ? mfaRequiredMessage(sso?.isPlatform === true ? captivoAccountUrl() : null)
    : null;

  return (
    <AuthShell>
      <LoginForm returnTo={returnTo} ssoEnabled={ssoEnabled} ssoLabel={ssoLabel} ssoError={errorMsg} />
    </AuthShell>
  );
}

/**
 * The refusal a workspace's two-step requirement produces. The provider is
 * named only when it is ours: for a tenant's own IdP the remedy lives with
 * their administrator, and a link into Captivo ID would be the wrong door.
 */
function mfaRequiredMessage(accountUrl: string | null) {
  return (
    <>
      Your organization requires two-step verification, and this sign-in did not include it.{" "}
      {accountUrl ? (
        <>Turn it on under <a href={accountUrl}>Security in your Captivo account</a>, then sign in again.</>
      ) : (
        <>Turn it on with your identity provider, or use a passkey that asks for your PIN or fingerprint, then sign in again.</>
      )}
    </>
  );
}

/**
 * Captivo ID signed the person in but has not verified their address, and the
 * console matches people by e-mail, so it cannot let them in yet.
 */
function unverifiedMessage(accountUrl: string | null) {
  return (
    <>
      Your e-mail address is not verified yet. Click the link we sent when you opened your Captivo account, then sign in
      again. If it has not arrived, check your junk folder or ask for a new link on{" "}
      {accountUrl ? <a href={accountUrl}>your Captivo account page</a> : "your Captivo account page"}.
    </>
  );
}

export default async function LoginPage(...args: Parameters<typeof LoginPageImpl>) {
  return withRequestTenant(() => LoginPageImpl(...args));
}
