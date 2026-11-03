import { applyGrantDecision } from "@/lib/access/decision";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { clientIp } from "@/lib/request-ip";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const dynamic = "force-dynamic";

/** POST { decision: "approve" | "deny", reason? } */
export const POST = mobileRoute("approve_grants", async (req, { user }, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.decision !== "approve" && body.decision !== "deny") return mobileJson({ error: "invalid_decision" }, 400);
  const outcome = await applyGrantDecision({
    actor: { id: user.id, email: user.email },
    grantId: id,
    decision: body.decision,
    reason: body.reason,
    clientIp: clientIp(req.headers) ?? null,
    via: "app",
  });
  if (outcome === "not_pending") return mobileJson({ error: "not_pending" }, 409);
  return mobileJson({ ok: true });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
