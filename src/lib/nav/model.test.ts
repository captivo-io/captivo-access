import { describe, it, expect, vi, afterEach } from "vitest";
import { buildNavModel, navLabel } from "./model";

const hrefs = (m: ReturnType<typeof buildNavModel>) => m.admin.flatMap((s) => s.items.map((i) => i.href));

describe("buildNavModel", () => {
  it("ADMIN: every section, with badges where there is something to count", () => {
    const m = buildNavModel("ADMIN", { pending: 3, unread: 5, live: 1, outdatedConnectors: 2, unreachableResources: 0 });
    expect(buildNavModel("ADMIN", { pending: 0, unread: 0, unreachableResources: 5 }).admin[2].items[1])
      .toMatchObject({ badge: 5, badgeTone: "bad", badgeTitle: "5 unreachable" });
    expect(m.admin.map((s) => s.label)).toEqual(["Overview", "Operate", "Infrastructure", "Identity & access", "Platform"]);
    expect(m.admin[1].items.map((i) => i.label)).toEqual(["Grants", "Access reviews", "Sessions", "Recordings", "Audit"]);
    const item = (label: string) => m.admin.flatMap((s) => s.items).find((i) => i.label === label);
    expect(item("Grants")).toMatchObject({ badge: 3, badgeTone: "warn" });
    expect(item("Sessions")).toMatchObject({ badge: 1, badgeTone: "ok" });
    expect(item("Connectors")).toMatchObject({ badge: 2, badgeTone: "warn" });
    expect(item("Resources")?.badge, "a zero is not shown").toBeUndefined();
    expect(hrefs(m)).toEqual(expect.arrayContaining([
      "/", "/admin/insights", "/admin/grants", "/admin/live", "/admin/recordings", "/admin/audit",
      "/admin/connectors", "/admin/sites", "/admin/policy",
      "/admin/users", "/admin/directory", "/admin/sso",
      "/admin/email", "/admin/log-forwarding", "/admin/updates",
    ]));
    expect(m.canSwitchView).toBe(true);
    expect(m.showSearch).toBe(true);
    expect(m.notificationsBadge, "5 unread + 3 waiting requests").toBe(8);
  });
  it("OPERATOR: overview and operations, grants badge, no configuration", () => {
    const m = buildNavModel("OPERATOR", { pending: 2, unread: 0 });
    expect(m.admin.map((s) => s.label)).toEqual(["Overview", "Operate"]);
    expect(m.admin[1].items.map((i) => i.label)).toEqual(["Grants", "Access reviews", "Sessions", "Audit"]);
    expect(m.admin[1].items[0].badge).toBe(2);
  });
  it("AUDITOR: no grants badge", () => {
    const m = buildNavModel("AUDITOR", { pending: 9, unread: 1 });
    expect(m.admin[1].items[0].badge).toBeUndefined();
    expect(m.notificationsBadge, "requests are not theirs to decide").toBe(1);
  });
  it("VENDOR: only their own access, no switch", () => {
    const m = buildNavModel("VENDOR", { pending: 0, unread: 0, myPending: 1 });
    expect(m.admin).toEqual([]);
    expect(m.canSwitchView).toBe(false);
    expect(m.showSearch).toBe(false);
    expect(m.user[0].items.map((i) => i.href)).toEqual(["/access", "/requests", "/history", "/preferences"]);
    expect(m.user[0].items[1].badge).toBe(1);
  });
  it("names the current page for the breadcrumb, by its longest matching item", () => {
    const m = buildNavModel("ADMIN", { pending: 0, unread: 0 });
    expect(navLabel(m, "/")).toBe("Console");
    expect(navLabel(m, "/admin/recordings/abc")).toBe("Recordings");
    expect(navLabel(m, "/admin/notifications")).toBe("Notifications");
    expect(navLabel(m, "/settings/recovery")).toBe("My account");
    expect(navLabel(m, "/admin/workspace/close")).toBe("Close workspace");
    expect(navLabel(m, "/access")).toBe("My access");
    expect(navLabel(m, "/nowhere")).toBeNull();
  });
});

describe("buildNavModel — Cloud", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("hides the self-host Custom domain page when MULTI_TENANT is on", () => {
    vi.stubEnv("MULTI_TENANT", "1");
    expect(hrefs(buildNavModel("ADMIN", { pending: 0, unread: 0 }))).not.toContain("/admin/domain");
  });
  it("shows it on self-host", () => {
    vi.stubEnv("MULTI_TENANT", "0");
    expect(hrefs(buildNavModel("ADMIN", { pending: 0, unread: 0 }))).toContain("/admin/domain");
  });
});
