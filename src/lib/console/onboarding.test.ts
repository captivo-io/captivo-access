import { describe, expect, it } from "vitest";
import { COMPLETE_BAND_MS, onboardingView, type OnboardingFacts } from "./onboarding";

const now = new Date("2026-11-18T12:00:00Z");
const fresh: OnboardingFacts = { connectorOnline: false, resources: 0, grants: 0, firstGrantAt: null, dismissedAt: null };

describe("onboardingView", () => {
  it("shows a new workspace at 0 / 3 with the connector step next", () => {
    expect(onboardingView(fresh, now)).toEqual({ show: true, done: [false, false, false], count: 0, current: 0, complete: false });
  });

  it("takes steps from data in any order", () => {
    const v = onboardingView({ ...fresh, resources: 2 }, now);
    expect(v.done).toEqual([false, true, false]);
    expect(v.count).toBe(1);
    expect(v.current).toBe(0);
  });

  it("keeps the band for a setup finished in the last week", () => {
    const v = onboardingView({ ...fresh, connectorOnline: true, resources: 1, grants: 1, firstGrantAt: new Date(now.getTime() - 3_600_000) }, now);
    expect(v).toMatchObject({ show: true, complete: true, current: -1, count: 3 });
  });

  it("goes straight to the Console for a setup finished long ago", () => {
    const v = onboardingView({ ...fresh, connectorOnline: true, resources: 1, grants: 1, firstGrantAt: new Date(now.getTime() - COMPLETE_BAND_MS - 1) }, now);
    expect(v.show).toBe(false);
  });

  it("stays hidden once an admin hid it, even mid-setup", () => {
    expect(onboardingView({ ...fresh, resources: 1, dismissedAt: now }, now).show).toBe(false);
  });
});
