import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { hasAnyUser } from "@/lib/auth/bootstrap";
import { safeReturnTo } from "@/lib/auth/return-to";
import { getOidcConfig } from "@/lib/auth/oidc-config";
import { resolveSetupRole } from "@/lib/auth/setup-role";
import { LoginForm } from "./login-form";
import { AuthShell } from "@/components/auth-shell";
import { withRequestTenant } from "@/lib/tenant/request";

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
    : null;

  return (
    <AuthShell>
      <LoginForm returnTo={returnTo} ssoEnabled={ssoEnabled} ssoLabel={ssoLabel} ssoError={errorMsg} />
    </AuthShell>
  );
}

export default async function LoginPage(...args: Parameters<typeof LoginPageImpl>) {
  return withRequestTenant(() => LoginPageImpl(...args));
}
