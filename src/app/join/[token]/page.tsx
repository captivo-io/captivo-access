import { BrandMark } from "@/components/brand";
import { AuthShell } from "@/components/auth-shell";
import { openLink, type LinkProblem } from "@/lib/live/invites";
import { guestProvider } from "@/lib/live/guest-provider";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join a live session" };

const PROBLEM: Record<LinkProblem, { title: string; text: string }> = {
  invalid: { title: "This invite link doesn't work", text: "Check that the whole link was copied, or ask whoever invited you for a new one." },
  used: { title: "This invite was already used", text: "An invite opens on one browser only. If that wasn't you, tell whoever invited you; they can send a new one." },
  expired: { title: "This invite has expired", text: "Ask whoever invited you for a new one." },
  removed: { title: "This invite was withdrawn", text: "An administrator withdrew it. Ask them if you still need to join." },
  ended: { title: "The session has ended", text: "There is nothing left to join. The session is in the workspace's recordings." },
};

const SIGN_IN_ERROR: Record<string, string> = {
  wrong_account: "You signed in under a different address from the one invited. Sign in with the invited address.",
  email_unverified: "Your Captivo address isn't verified yet. Open the link in the e-mail Captivo sent you, then try again.",
  mfa_required: "This workspace asks invited guests for two-step verification. Turn it on in your Captivo account, then try again.",
  no_provider: "This workspace has no sign-in provider for guests, so the invite can't be used. Tell whoever invited you.",
  sso: "Signing in didn't work. Try again.",
};

async function JoinPageImpl({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const r = await openLink(token);
  if (!r.ok) {
    const p = PROBLEM[r.problem];
    return (
      <AuthShell>
        <BrandMark size={38} className="auth-mark" />
        <h1>{p.title}</h1>
        <p>{p.text}</p>
      </AuthShell>
    );
  }
  const { invite, siteName, userLabel } = r.link;
  // Captivo ID, or on a self-hosted console the workspace's own provider.
  const captivo = (await guestProvider())?.trusted !== false;
  const mins = Math.max(1, Math.round((invite.expiresAt.getTime() - Date.now()) / 60_000));
  const lasts = invite.untilSessionEnds ? "Until the session ends" : mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min left` : `${mins} min left`;
  return (
    <AuthShell>
      <BrandMark size={38} className="auth-mark" />
      <h1>Join a live session</h1>
      <p>
        {invite.createdByEmail ?? "An administrator"} invited you to {invite.canControl ? "watch, and if needed take control of," : "watch"} {userLabel}&apos;s session on {siteName}.
      </p>
      {error && SIGN_IN_ERROR[error] && (
        <div className="authx-err" role="alert"><span>{SIGN_IN_ERROR[error]}</span></div>
      )}
      <dl className="authx-facts">
        <div><dt>Invited address</dt><dd>{invite.email}</dd></div>
        <div><dt>You can</dt><dd>{invite.canControl ? "Watch and take control" : "Watch"}</dd></div>
        <div><dt>Time</dt><dd>{lasts}</dd></div>
      </dl>
      <div className="auth-actions">
        <a className="btn btn-captivo" href={`/api/join/start?t=${encodeURIComponent(token)}`}>
          {captivo && <BrandMark size={18} />} {captivo ? "Sign in with Captivo to join" : "Sign in to join"}
        </a>
      </div>
      <p className="authx-help">
        Sign in with the invited address{captivo ? "; if you have no Captivo account, you can create one on the way" : ""}. The link then works on this browser only, and for nothing but this session. Everything in the session is recorded, including that you joined.
      </p>
    </AuthShell>
  );
}

export default async function JoinPage(...args: Parameters<typeof JoinPageImpl>) {
  return withRequestTenant(() => JoinPageImpl(...args));
}
