import { requireCapability } from "@/lib/current-user";
import { getDashboardStats } from "@/lib/dashboard/stats";
import { getInsights } from "@/lib/dashboard/insights";
import { InsightsView, RANGES, type Range } from "../../_dashboard/insights-view";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

async function InsightsPageImpl({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireCapability("read_console");
  const asked = Number((await searchParams).range);
  const range: Range = (RANGES as readonly number[]).includes(asked) ? (asked as Range) : 30;
  const [stats, insights] = await Promise.all([getDashboardStats(), getInsights(new Date(), range)]);
  return (
    <main>
      <InsightsView stats={stats} insights={insights} range={range} />
    </main>
  );
}

export default async function InsightsPage(...args: Parameters<typeof InsightsPageImpl>) {
  return withRequestTenant(() => InsightsPageImpl(...args));
}
