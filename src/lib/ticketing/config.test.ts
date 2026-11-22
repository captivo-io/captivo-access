import { describe, it, expect } from "vitest";
import { parseSystem } from "./config";

describe("parseSystem", () => {
  it("takes a ServiceNow instance by its root", () => {
    const r = parseSystem({ kind: "servicenow", baseUrl: "https://acme.service-now.com/", username: "svc", secret: "pw", tables: ["change_request", "bogus"], allowedStates: [" Implement ", "Implement", ""], defaultMode: "itsm" }, { cloud: true });
    expect(r).toMatchObject({ ok: true, secret: "pw", data: { baseUrl: "https://acme.service-now.com", tables: ["change_request"], allowedStates: ["Implement"], defaultMode: "itsm" } });
  });
  it("refuses plain http on Cloud, credentials in the URL, and missing parts", () => {
    expect(parseSystem({ kind: "jira", baseUrl: "http://acme.atlassian.net", username: "a@b" }, { cloud: true })).toMatchObject({ ok: false, error: "https_required" });
    expect(parseSystem({ kind: "jira", baseUrl: "http://jira.corp", username: "a@b" }, { cloud: false }).ok).toBe(true);
    expect(parseSystem({ kind: "jira", baseUrl: "https://u:p@acme.atlassian.net", username: "a@b" }, { cloud: true })).toMatchObject({ ok: false, error: "invalid_url" });
    expect(parseSystem({ kind: "servicenow", baseUrl: "https://x.service-now.com", username: "" }, { cloud: true })).toMatchObject({ ok: false, error: "username_required" });
    expect(parseSystem({ kind: "servicenow", baseUrl: "https://x.service-now.com", username: "s", tables: [] }, { cloud: true })).toMatchObject({ ok: false, error: "tables_required" });
    expect(parseSystem({ kind: "jira", baseUrl: "https://a.atlassian.net", username: "s", startField: "x;drop" }, { cloud: true })).toMatchObject({ ok: false, error: "invalid_field" });
  });
  it("keeps numbers-only simple, and never lets it approve", () => {
    expect(parseSystem({ kind: "none", defaultMode: "itsm", writeNotes: true }, { cloud: true })).toMatchObject({ ok: true, data: { kind: "none", baseUrl: null, defaultMode: "required", writeNotes: false } });
  });
});
