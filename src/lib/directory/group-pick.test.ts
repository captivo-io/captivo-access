import { describe, it, expect } from "vitest";
import { parentOf, isMapped, filterMappings } from "./group-pick";

describe("group picker helpers", () => {
  it("shows where a group lives", () => {
    expect(parentOf("CN=DB-Ops,OU=Groups,DC=corp,DC=local")).toBe("OU=Groups,DC=corp,DC=local");
    expect(parentOf("DB-Ops")).toBe("");
  });

  it("knows a group is mapped by DN or by bare name", () => {
    const dn = "CN=DB-Ops,OU=Groups,DC=corp,DC=local";
    expect(isMapped(dn, ["cn=db-ops, ou=groups, dc=corp, dc=local"])).toBe(true);
    expect(isMapped(dn, ["db-ops"])).toBe(true);
    expect(isMapped(dn, ["CN=DB-Ops,OU=Other,DC=corp,DC=local", "Admins"])).toBe(false);
  });

  it("filters mappings by group or target", () => {
    const rows = [{ groupDN: "CN=Admins,DC=x", target: "Admin" }, { groupDN: "CN=Vendors,DC=x", target: "Proxmox" }];
    expect(filterMappings(rows, "prox").map((r) => r.groupDN)).toEqual(["CN=Vendors,DC=x"]);
    expect(filterMappings(rows, " ")).toHaveLength(2);
  });
});
