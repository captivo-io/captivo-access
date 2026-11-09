import { describe, it, expect } from "vitest";
import { alertKey, alertPush, freshAlerts } from "../alert-push";
import type { PlatformAlert } from "../overview";

const acme = { id: "t1", slug: "acme", name: "Acme" };
const cert: PlatformAlert = { level: "danger", kind: "provisioning", tenant: acme, text: "certificate missing" };
const job = (h: number): PlatformAlert => ({ level: "warn", kind: "cron_daily_stale", tenant: acme, text: `audit-retention last ran ${h}h ago` });
const suspended: PlatformAlert = { level: "info", kind: "suspended", tenant: acme, text: "Suspended" };

describe("platform alert push", () => {
  it("tells a new alert once, and not again while it stays", () => {
    const first = freshAlerts([cert], []);
    expect(first.fresh).toEqual([cert]);
    expect(freshAlerts([cert], first.keys).fresh).toEqual([]);
  });

  it("the same alert with a new number is not new", () => {
    expect(alertKey(job(27))).toBe(alertKey(job(28)));
    expect(freshAlerts([job(28)], freshAlerts([job(27)], []).keys).fresh).toEqual([]);
  });

  it("an alert that cleared and came back is told again", () => {
    const cleared = freshAlerts([], freshAlerts([cert], []).keys);
    expect(cleared.keys).toEqual([]);
    expect(freshAlerts([cert], cleared.keys).fresh).toEqual([cert]);
  });

  it("info-level entries (suspended, deleted) never ring a phone", () => {
    expect(freshAlerts([suspended], []).fresh).toEqual([]);
  });

  it("one alert names the workspace; several are counted", () => {
    expect(alertPush([cert])).toMatchObject({ title: "Platform alert", body: "Acme: certificate missing" });
    expect(alertPush([cert, job(30)]).title).toBe("2 new platform alerts");
  });
});
