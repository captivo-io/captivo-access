import { describe, it, expect } from "vitest";
import { autoIcon, resolveIcon, kindOf, protoLabel, slugFromName, ICON_NAMES } from "./icons";

describe("resource icons", () => {
  it("has the 21 icons", () => expect(ICON_NAMES).toHaveLength(21));
  it("picks from the name and address", () => {
    expect(autoIcon("pfSense 10.0.0.1", "web")).toBe("firewall");
    expect(autoIcon("Proxmox Pro", "web")).toBe("layers");
    expect(autoIcon("Exchange-RDP", "rdp")).toBe("mail");
    expect(autoIcon("DC-RDP", "rdp")).toBe("directory");
    expect(autoIcon("Securify-WebConsole", "web")).toBe("shield");
    expect(autoIcon("Securify-SSH", "ssh")).toBe("terminal"); // weak match: web only
    expect(autoIcon("Captivo On-Prem", "web")).toBe("cloud");
    expect(autoIcon("WIN-SK", "rdp")).toBe("desktop");
    expect(autoIcon("Muhasebe Wiki", "web")).toBe("globe");
    expect(autoIcon("Redis 10.0.0.9:6379", "tunnel")).toBe("database");
    expect(autoIcon("License server 10.0.0.9:27000", "tunnel")).toBe("plug");
  });
  it("keeps a picked icon and colour, else automatic", () => {
    expect(resolveIcon({ name: "x", kind: "rdp", iconName: "mail", iconColor: "green" })).toEqual({ name: "mail", color: "green", auto: false });
    expect(resolveIcon({ name: "Grafana", kind: "web", iconName: "nonsense" })).toEqual({ name: "chart", color: "blue", auto: true });
  });
  it("reads the kind and protocol", () => {
    expect(kindOf({ accessMode: "GATEWAY", protocol: "SSH" })).toBe("ssh");
    expect(kindOf({ accessMode: "ISOLATED" })).toBe("isolated");
    expect(kindOf({ accessMode: "TUNNEL" })).toBe("tunnel");
    expect(protoLabel("tunnel", null)).toBe("TCP");
    expect(kindOf({ accessMode: "KUBERNETES" })).toBe("kubernetes");
    expect(protoLabel("kubernetes", null)).toBe("K8S");
    expect(autoIcon("Prod cluster", "kubernetes")).toBe("cube");
    expect(protoLabel("web", "http://10.0.0.1:8080")).toBe("HTTP");
    expect(protoLabel("vnc", null)).toBe("VNC");
  });
  it("makes a host label from a name", () => {
    expect(slugFromName("Muhasebe Wiki")).toBe("muhasebe-wiki");
    expect(slugFromName("Şirket İçi Çağrı Sistemi!")).toBe("sirket-ici-cagri-sistemi");
  });
});
