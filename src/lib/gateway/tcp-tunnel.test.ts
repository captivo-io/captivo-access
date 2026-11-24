import { describe, expect, it } from "vitest";
import { suggestedLocalPort, tunnelBlock, tunnelCommand, validLocalPort } from "./tcp-tunnel";

describe("tunnelBlock", () => {
  it("opens a tunnel resource on a connector that relays raw TCP", () => {
    expect(tunnelBlock({ accessMode: "TUNNEL", recordingRequired: false, connectorVersion: "2.58.3" })).toBeNull();
  });
  it("refuses other resources, required recording and old connectors", () => {
    expect(tunnelBlock({ accessMode: "GATEWAY", recordingRequired: false, connectorVersion: "2.58.3" })).toBe("not_tunnel");
    expect(tunnelBlock({ accessMode: "TUNNEL", recordingRequired: true, connectorVersion: "2.58.3" })).toBe("recording_required");
    expect(tunnelBlock({ accessMode: "TUNNEL", recordingRequired: false, connectorVersion: "2.38.0" })).toBe("connector_outdated");
  });
});

describe("tunnel command", () => {
  it("forwards a local port to the resource through the jump host", () => {
    expect(tunnelCommand({ code: "k7f3q9wz2m4x", jumpHost: "acme.cloud.captivo.io", jumpPort: 2222, targetHost: "redis.corp", targetPort: 6379, localPort: 6379 }))
      .toBe("ssh -L 6379:redis.corp:6379 -o ExitOnForwardFailure=yes -p 2222 k7f3q9wz2m4x@acme.cloud.captivo.io");
  });
  it("brackets an IPv6 target and leaves out port 22", () => {
    expect(tunnelCommand({ code: "k7f3q9wz2m4x", jumpHost: "jump.example", jumpPort: 22, targetHost: "fd00::5", targetPort: 443, localPort: 10443 }))
      .toBe("ssh -L 10443:[fd00::5]:443 -o ExitOnForwardFailure=yes k7f3q9wz2m4x@jump.example");
  });
  it("suggests a port anyone may listen on", () => {
    expect(suggestedLocalPort(6379)).toBe(6379);
    expect(suggestedLocalPort(443)).toBe(10443);
    expect(validLocalPort(0)).toBe(false);
    expect(validLocalPort(65536)).toBe(false);
    expect(validLocalPort(8080)).toBe(true);
  });
});
