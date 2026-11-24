import { describe, expect, it } from "vitest";
import { kubeBlock, kubeconfigYaml, kubeContextName, kubeParamsFrom, kubeServerUrl, kubeSetupYaml, parseApiServer, parseKubeParams, validGroup } from "./params";

describe("kubernetes params", () => {
  it("reads the API server as an admin pastes it", () => {
    expect(parseApiServer("10.0.0.5:6443")).toEqual({ host: "10.0.0.5", port: 6443 });
    expect(parseApiServer("https://k8s.internal:6443")).toEqual({ host: "k8s.internal", port: 6443 });
    expect(parseApiServer("ABC123.gr7.eu-west-1.eks.amazonaws.com")).toEqual({ host: "abc123.gr7.eu-west-1.eks.amazonaws.com", port: 443 });
    expect(parseApiServer("[fd00::5]:6443")).toEqual({ host: "fd00::5", port: 6443 });
    expect(parseApiServer("http://10.0.0.5:6443")).toBeNull();
    expect(parseApiServer("10.0.0.5:6443/api")).toBeNull();
    expect(parseApiServer("")).toBeNull();
  });

  it("never lets a user act in a system: group", () => {
    expect(validGroup("captivo-users")).toBe(true);
    expect(validGroup("system:masters")).toBe(false);
    expect(validGroup("SYSTEM:authenticated")).toBe(false);
    expect(kubeParamsFrom({ kubeGroups: "ops, system:masters" })).toEqual({ error: "invalid_kube_group" });
  });

  it("validates and defaults the form's fields", () => {
    expect(kubeParamsFrom({ namespaces: "web, Bad_NS" })).toEqual({ error: "invalid_namespace" });
    expect(kubeParamsFrom({ caCertPem: "not a cert" })).toEqual({ error: "invalid_ca_cert" });
    const p = kubeParamsFrom({ namespaces: "web jobs web", readOnly: true, portForward: true });
    expect(p).toMatchObject({ identity: "impersonate", groups: ["captivo-users"], namespaces: ["web", "jobs"], readOnly: true, portForward: false });
    expect(parseKubeParams(null)).toMatchObject({ identity: "impersonate", groups: ["captivo-users"], namespaces: [], readOnly: false, caCertPem: null });
    expect(parseKubeParams({ identity: "service_account", groups: ["system:masters"] })).toMatchObject({ identity: "service_account", groups: ["captivo-users"] });
  });

  it("opens only on a new enough connector", () => {
    expect(kubeBlock({ accessMode: "KUBERNETES", connectorVersion: "2.62.0" })).toBeNull();
    expect(kubeBlock({ accessMode: "KUBERNETES", connectorVersion: "2.61.1" })).toBe("connector_outdated");
    expect(kubeBlock({ accessMode: "DATABASE", connectorVersion: "2.62.0" })).toBe("not_kubernetes");
  });

  it("writes a kubeconfig for the console's address", () => {
    const server = kubeServerUrl("https://acme.cloud.captivo.io/", "site_1");
    expect(server).toBe("https://acme.cloud.captivo.io/k8s/site_1");
    const name = kubeContextName("Prod Cluster (EU)");
    expect(name).toBe("captivo-prod-cluster-eu");
    const y = kubeconfigYaml({ server, context: name, token: "abc123", namespace: "web", expiresAt: new Date("2026-11-24T18:00:00Z") });
    expect(y).toContain("server: https://acme.cloud.captivo.io/k8s/site_1");
    expect(y).toContain("    token: abc123");
    expect(y).toContain("    namespace: web");
    expect(y).toContain("current-context: captivo-prod-cluster-eu");
  });

  it("sets up impersonation for the named groups only", () => {
    const y = kubeSetupYaml({ identity: "impersonate", groups: ["captivo-users", "ops"], readOnly: true });
    expect(y).toContain('resourceNames: ["captivo-users", "ops"]');
    expect(y).toContain("name: view");
    expect(y).not.toContain("system:masters");
    expect(kubeSetupYaml({ identity: "service_account", groups: [], readOnly: false })).toContain("kind: ServiceAccount\n  name: captivo-access");
  });
});
