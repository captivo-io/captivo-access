import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./center-picture", () => ({ getCenterPicture: vi.fn() }));

import { getProductMenu } from "./switcher-data";
import { getCenterPicture } from "./center-picture";

beforeEach(() => { vi.clearAllMocks(); });

describe("getProductMenu", () => {
  it("renders no menu when the centre said nothing", async () => {
    // Self-hosted, a tenant with no organisation and an unreachable centre all
    // arrive here as null, and none of them should render a switcher.
    vi.mocked(getCenterPicture).mockResolvedValue(null);
    await expect(getProductMenu()).resolves.toEqual([]);
  });

  it("marks ACCESS as current, because this code only runs inside Access", async () => {
    vi.mocked(getCenterPicture).mockResolvedValue({
      entitlements: [
        { product: "PORTAL", plan: null, limits: null, expiresAt: null },
        { product: "ACCESS", plan: "free", limits: null, expiresAt: null },
      ],
      links: [],
    } as never);
    const menu = await getProductMenu();
    expect(menu.find((m) => m.product === "ACCESS")?.state).toBe("current");
  });

  it("sends an unset-up Portal to Portal's own address, not to Access setup", async () => {
    // The two addresses are the one piece of production wiring here; swapping
    // them would send people to the wrong product and look like nothing.
    vi.mocked(getCenterPicture).mockResolvedValue({
      entitlements: [
        { product: "PORTAL", plan: null, limits: null, expiresAt: null },
        { product: "ACCESS", plan: "free", limits: null, expiresAt: null },
      ],
      links: [],
    } as never);
    const portal = (await getProductMenu()).find((m) => m.product === "PORTAL");
    expect(portal?.href).toBe("https://app.captivo.io");
  });
});
