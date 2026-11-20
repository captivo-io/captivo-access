import { describe, expect, it } from "vitest";
import { GROUP_MEMBERS_MAX, parseGroupInput } from "./groups";

describe("parseGroupInput", () => {
  it("takes a name and members, dropping repeats", () => {
    expect(parseGroupInput({ name: " DC ", members: [{ connectorId: "a" }, { connectorId: "b", standby: true }, { connectorId: "a", standby: true }] })).toEqual({
      name: "DC",
      members: [{ connectorId: "a", standby: false }, { connectorId: "b", standby: true }],
    });
  });
  it("needs an active member", () => {
    expect(parseGroupInput({ name: "DC", members: [{ connectorId: "a", standby: true }] })).toEqual({ error: "no_active_member" });
    expect(parseGroupInput({ name: "DC", members: [] })).toEqual({ error: "no_members" });
  });
  it("refuses junk", () => {
    expect(parseGroupInput({ name: "", members: [{ connectorId: "a" }] })).toEqual({ error: "invalid_name" });
    expect(parseGroupInput({ name: "x".repeat(61), members: [{ connectorId: "a" }] })).toEqual({ error: "invalid_name" });
    expect(parseGroupInput({ name: "DC", members: "a" })).toEqual({ error: "invalid_members" });
    expect(parseGroupInput({ name: "DC", members: [{ connectorId: 1 }] })).toEqual({ error: "invalid_members" });
    expect(parseGroupInput({ name: "DC", members: Array.from({ length: GROUP_MEMBERS_MAX + 1 }, (_, i) => ({ connectorId: `c${i}` })) })).toEqual({ error: "too_many_members" });
  });
});
