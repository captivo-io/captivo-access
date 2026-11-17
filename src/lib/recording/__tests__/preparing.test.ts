import { describe, it, expect } from "vitest";
import { videoPreparing } from "../preparing";

const rdp = { format: "GUAC", protocol: "rdp", videoReady: false, reportedAt: null };

describe("videoPreparing", () => {
  it("is true for an RDP/VNC recording not yet reported, on a connector that makes videos", () => {
    expect(videoPreparing(rdp, "2.21.0")).toBe(true);
    expect(videoPreparing({ ...rdp, protocol: "VNC" }, "2.22.3")).toBe(true);
  });
  it("is false once there is a video or the connector has reported (kept as it is)", () => {
    expect(videoPreparing({ ...rdp, videoReady: true }, "2.22.0")).toBe(false);
    expect(videoPreparing({ ...rdp, reportedAt: new Date() }, "2.22.0")).toBe(false);
  });
  it("is false for terminal sessions, other formats, and connectors that never convert", () => {
    expect(videoPreparing({ ...rdp, protocol: "ssh" }, "2.22.0")).toBe(false);
    expect(videoPreparing({ ...rdp, format: "VIDEO" }, "2.22.0")).toBe(false);
    expect(videoPreparing(rdp, "2.20.4")).toBe(false);
    expect(videoPreparing(rdp, null)).toBe(false);
  });
});
