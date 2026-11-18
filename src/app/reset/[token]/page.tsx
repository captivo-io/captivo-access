import { verifyPasskeyReset } from "@/lib/auth/passkey-reset";
import { BrandMark } from "@/components/brand";
import { AuthShell } from "@/components/auth-shell";
import { withRequestTenant } from "@/lib/tenant/request";
import { ResetPasskeyForm } from "./reset-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "New passkey" };

async function ResetPageImpl({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reset = await verifyPasskeyReset(token);

  if (!reset || reset.user.status !== "ACTIVE") {
    return (
      <AuthShell>
        <BrandMark size={38} className="auth-mark" />
        <h1>This link no longer works</h1>
        <p>It was already used, it expired, or a newer link replaced it. Ask your administrator for a new one.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <BrandMark size={38} className="auth-mark" />
      <h1>Set up a new passkey</h1>
      <p>{reset.user.email}: your administrator removed your old passkeys. Register a new one on this device to sign in again.</p>
      <ResetPasskeyForm token={token} />
    </AuthShell>
  );
}

export default async function ResetPage(...args: Parameters<typeof ResetPageImpl>) {
  return withRequestTenant(() => ResetPageImpl(...args));
}
