import { describe, it, expect } from "vitest";
import { acceptAccounts, adoptProblem, adoptedName, type DiscoveredRow } from "@/lib/vault/discovery";

const row = (o: Partial<DiscoveredRow> = {}): DiscoveredRow => ({ name: "deploy", uid: 1001, shell: "/bin/bash", home: "/home/deploy", login: true, passAgeDays: 10, managedBy: null, ...o });

describe("account discovery", () => {
  it("keeps only well-formed accounts from the connector's list", () => {
    const got = acceptAccounts([
      { name: "ana", uid: 1000, shell: "/bin/bash", home: "/home/ana", login: true, passAgeDays: 3, hash: "$6$secret" },
      { name: "bad name", uid: 1 }, { name: "x", uid: "1" }, null, "str",
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: "ana", login: true, passAgeDays: 3 });
    expect(JSON.stringify(got)).not.toContain("secret");
    expect(acceptAccounts(undefined)).toEqual([]);
    expect(acceptAccounts(Array.from({ length: 600 }, (_, i) => ({ name: `u${i}`, uid: i }))).length).toBe(500);
  });

  it("will not take over the administrator account, root, a managed account or one with no shell", () => {
    expect(adoptProblem(row(), "ops")).toBeNull();
    expect(adoptProblem(row({ name: "ops" }), "ops")).toMatch(/lock Captivo out/);
    expect(adoptProblem(row({ managedBy: { id: "s1", name: "Build box" } }), "ops")).toMatch(/Already a resource: Build box/);
    expect(adoptProblem(row({ login: false }), "ops")).toMatch(/no shell/);
    expect(adoptProblem(row({ name: "root", uid: 0 }), "ops")).toMatch(/root/);
  });

  it("takes over a Windows account unless it is built in, disabled or the administrator Captivo uses", () => {
    const w = (o: Partial<DiscoveredRow> = {}) => row({ name: "alice", uid: 1001, shell: "", login: true, ...o });
    expect(adoptProblem(w(), "Administrator", "windows")).toBeNull();
    expect(adoptProblem(w({ name: "Administrator", uid: 500 }), "HOST\\administrator", "windows")).toMatch(/lock Captivo out/);
    expect(adoptProblem(w({ name: "Administrator", uid: 500 }), "root", "windows")).toMatch(/built-in Administrator/);
    expect(adoptProblem(w({ name: "Guest", uid: 501 }), "x", "windows")).toMatch(/Guest/);
    expect(adoptProblem(w({ login: false }), "x", "windows")).toMatch(/disabled/);
    expect(acceptAccounts([{ name: "svc$", uid: 1010, passAgeDays: 3 }])[0].name).toBe("svc$");
  });

  it("names the new resource after the one it came from", () => {
    expect(adoptedName("Build box", "deploy")).toBe("Build box · deploy");
    expect(adoptedName("x".repeat(100), "deploy").length).toBe(80);
  });
});
