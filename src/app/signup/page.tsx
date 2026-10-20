import { notFound, redirect } from "next/navigation";
import { withRequestTenant } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { signupEnabled } from "@/lib/signup/flow";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { AuthShell } from "@/components/auth-shell";
import { BrandMark } from "@/components/brand";
import { SignupForm } from "./signup-form";
import { captivoRegisterUrl } from "@/lib/auth/captivo-id-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create a workspace" };

// Public, platform-host only, and only when the platform operator enabled it.
async function SignupPageImpl({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (currentTenantId() !== PLATFORM_TENANT_ID || !(await signupEnabled())) notFound();
  // With a centre configured the form lives there; this page only hands over.
  const central = captivoRegisterUrl();
  if (central) redirect(central);
  const sp = await searchParams;
  const domain = consoleDomain() ?? "";
  return (
    <AuthShell>
      <BrandMark size={38} className="auth-mark" />
      <h1>Create your workspace</h1>
      <p>Start a free {14}-day trial. Confirm your email and you&apos;ll be the workspace&apos;s first admin.</p>
      {sp.error === "invalid_token" && <p className="notice error">This confirmation link is invalid or has expired. Request a new one below.</p>}
      {sp.error === "slug_taken" && <p className="notice error">That workspace address was taken in the meantime. Pick another.</p>}
      <SignupForm domain={domain} />
    </AuthShell>
  );
}

export default async function SignupPage(...args: Parameters<typeof SignupPageImpl>) {
  return withRequestTenant(() => SignupPageImpl(...args));
}
