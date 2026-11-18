// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GrantRowJSON } from "@/lib/access/grant-rows";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const { GrantsView } = await import("../grants-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-18T12:00:00Z");
const grant = (over: Partial<GrantRowJSON>): GrantRowJSON => ({
  id: "g", userId: "admin", siteId: "rdp", kind: "permanent", state: "active", reason: "allow",
  startsAt: null, endsAt: null, createdAt: "2026-08-02T09:00:00.000Z", endedAt: null,
  days: null, hours: null, zone: null, nextStart: null, note: null, denyReason: null, permanent: true, soon: false, ...over,
});
const rows: GrantRowJSON[] = [
  ...Array.from({ length: 5 }, (_, i) => grant({ id: `p${i}` })),
  grant({ id: "t1", userId: "vendor", kind: "timed", endsAt: "2026-11-18T14:10:00.000Z", permanent: false, soon: true, note: "Ticket #4821" }),
  grant({ id: "e1", userId: "vendor", state: "ended", reason: "revoked", endedAt: "2026-11-16T10:00:00.000Z", permanent: false }),
];
const users = [
  { id: "admin", name: "Serdar Kurt", email: "s@x.io", role: "ADMIN" as const },
  { id: "vendor", name: "Demo Vendor", email: "d@x.io", role: "VENDOR" as const },
];
const sites = [{ id: "rdp", name: "DC-RDP", proto: "RDP", remote: true, host: "10.0.0.2:3389", icon: "directory", color: "violet" as const, logoUrl: null, logoBg: null }];

const text = () => document.body.textContent ?? "";
const btn = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;

async function mount() {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(
    <GrantsView head={<h1>Grants</h1>} pending={null} rows={rows} users={users} sites={sites}
      canApprove canConfigure maxGrantDays={0} serverNow={NOW} initialFilter="all" openNew={false} />,
  ));
  return root;
}

describe("grants view", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=root></div>";
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it("groups by user, counts, and warns about permanent grants", async () => {
    await mount();
    expect(document.querySelectorAll(".gr-group")).toHaveLength(2);
    expect(text()).toContain("5 of 6 grants are permanent.");
    expect(text()).toContain("2h 10m left");
    expect(text()).toContain("Ticket #4821");
    expect(text()).toMatch(/Revoked Nov 16/);
    expect(document.querySelector(".gr-role.vendor")?.textContent).toBe("VENDOR");
  });

  it("filters from the strip and the segmented control", async () => {
    await mount();
    await act(async () => btn("Ended").click());
    expect(document.querySelectorAll(".gr-row:not(.gr-cols)")).toHaveLength(1);
    await act(async () => (document.querySelector(".gr-kpis .kcell:nth-child(4)") as HTMLButtonElement).click());
    expect(text()).toContain("Ending in 24 h ×");
    expect(document.querySelectorAll(".gr-row:not(.gr-cols)")).toHaveLength(1);
    expect(text()).toContain("are permanent."); // only the permanent filter hides the banner
  });

  it("selects a group and revokes after a second click", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, done: 5, skipped: 0 }) }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    const groupBox = document.querySelector('.gr-ghead input[aria-label*="Serdar"]') as HTMLInputElement;
    await act(async () => groupBox.click());
    expect(text()).toContain("5 grants selected");
    await act(async () => btn("Revoke").click());
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => btn("Revoke 5 grants?").click());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/grants/bulk", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ ids: ["p0", "p1", "p2", "p3", "p4"], action: "revoke", days: 30 });
    expect(refresh).toHaveBeenCalled();
  });
});
