import { describe, it, expect } from "vitest";
import { canDeleteConnector } from "./deletion";

describe("canDeleteConnector", () => {
  it("revoked + 0 sites -> ok", () => expect(canDeleteConnector({ status: "REVOKED", siteCount: 0 })).toEqual({ ok: true }));
  it("revoked + sites -> has_sites", () => expect(canDeleteConnector({ status: "REVOKED", siteCount: 2 })).toEqual({ ok: false, reason: "has_sites" }));
  it("online + 0 -> not_revoked", () => expect(canDeleteConnector({ status: "ONLINE", siteCount: 0 })).toEqual({ ok: false, reason: "not_revoked" }));
  it("pending + 0 -> not_revoked", () => expect(canDeleteConnector({ status: "PENDING", siteCount: 0 })).toEqual({ ok: false, reason: "not_revoked" }));
  it("checks status before site count", () => expect(canDeleteConnector({ status: "ONLINE", siteCount: 5 })).toEqual({ ok: false, reason: "not_revoked" }));
  it("with its sites, needs the name typed back", () => {
    expect(canDeleteConnector({ status: "REVOKED", siteCount: 12, withSites: { name: "Home Lab", confirmName: "Home Lab" } })).toEqual({ ok: true });
    expect(canDeleteConnector({ status: "REVOKED", siteCount: 12, withSites: { name: "Home Lab", confirmName: "home" } })).toEqual({ ok: false, reason: "confirm_mismatch" });
    expect(canDeleteConnector({ status: "ONLINE", siteCount: 12, withSites: { name: "Home Lab", confirmName: "Home Lab" } })).toEqual({ ok: false, reason: "not_revoked" });
  });
});
