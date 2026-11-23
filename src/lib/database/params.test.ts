import { afterEach, describe, expect, it, vi } from "vitest";
import { dbEngineLabel, dbEngineOf, dbEngineWire, dbMinConnector, dbParamsFrom, dbPublicPort, parseDbParams, sqlcmdCommand } from "./params";

describe("SQL Server database params", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("names and versions the engine", () => {
    expect(dbEngineOf("MSSQL")).toBe("MSSQL");
    expect(dbEngineOf("ORACLE")).toBe("POSTGRES");
    expect(dbEngineWire("MSSQL")).toBe("mssql");
    expect(dbEngineLabel("MSSQL")).toBe("SQL Server");
    expect(dbMinConnector("MSSQL")).toBe("2.56.0");
  });
  it("takes no default database and no allowed list", () => {
    expect(parseDbParams({}, "MSSQL").database).toBe("");
    expect(dbParamsFrom({ database: "", databases: "a, b" }, "MSSQL")).toEqual({ database: "", databases: [], tls: "require", caCertPem: null });
  });
  it("publishes its own port and a sqlcmd line", () => {
    expect(dbPublicPort("MSSQL")).toBe(11433);
    vi.stubEnv("MSSQL_PUBLIC_PORT", "1433");
    expect(dbPublicPort("MSSQL")).toBe(1433);
    expect(sqlcmdCommand({ host: "acme.cloud.captivo.io", port: 11433, ticket: "tk", database: "crm" })).toBe("sqlcmd -S tcp:acme.cloud.captivo.io,11433 -U tk -P x -d crm");
  });
});
