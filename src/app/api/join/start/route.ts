import type { NextRequest } from "next/server";
import { startGuestSignIn } from "@/lib/live/guest-signin";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

// The "Sign in with Captivo" button on a session invite: off to the provider.
export const GET = withTenantRoute(async (req: NextRequest) =>
  startGuestSignIn(req, req.nextUrl.searchParams.get("t") ?? "", req.nextUrl.searchParams.get("stepUp") === "1"),
);
