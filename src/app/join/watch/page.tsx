import { cookies } from "next/headers";
import { BrandMark } from "@/components/brand";
import { AuthShell } from "@/components/auth-shell";
import { db } from "@/lib/db";
import { guestFromPass } from "@/lib/live/invites";
import { GUEST_COOKIE } from "@/lib/live/invite-token";
import { findOwnSession } from "@/lib/dataplane/client";
import { withRequestTenant } from "@/lib/tenant/request";
import { GuestWatch } from "./guest-watch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live session" };

function Closed({ title, text }: { title: string; text: string }) {
  return (
    <AuthShell>
      <BrandMark size={38} className="auth-mark" />
      <h1>{title}</h1>
      <p>{text}</p>
    </AuthShell>
  );
}

// An invited guest's view of the one session their pass is for. Nothing here
// reads a console sign-in: the pass is all the guest has.
async function GuestWatchPageImpl() {
  const g = await guestFromPass((await cookies()).get(GUEST_COOKIE)?.value);
  if (!g) return <Closed title="Your invite has ended" text="It expired or was withdrawn, or this browser never joined with it. Ask whoever invited you for a new one." />;
  const s = await findOwnSession(g.sessionId);
  if (!s || s.siteId !== g.siteId) return <Closed title="The session has ended" text="There is nothing left to watch." />;
  const [site, user] = await Promise.all([
    db.site.findUnique({ where: { id: g.siteId }, select: { name: true } }),
    db.user.findUnique({ where: { id: g.sessionUserId }, select: { name: true, email: true } }),
  ]);
  return (
    <GuestWatch
      sessionId={g.sessionId}
      terminal={!!s.native && s.protocol === "ssh"}
      canControl={g.canControl && (!s.native || !!s.controllable)}
      guestName={g.guestName}
      guestEmail={g.email}
      userLabel={user?.name || user?.email || "the user"}
      siteName={site?.name ?? s.host}
      expiresAt={g.expiresAt.toISOString()}
      untilSessionEnds={g.untilSessionEnds}
    />
  );
}

export default async function GuestWatchPage() {
  return withRequestTenant(() => GuestWatchPageImpl());
}
