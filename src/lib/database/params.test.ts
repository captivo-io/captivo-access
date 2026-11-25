import { afterEach, describe, expect, it, vi } from "vitest";
import { dbEngineLabel, dbEngineOf, dbEngineWire, dbMinConnector, dbParamsFrom, dbPublicPort, mongoshCommand, mongoUrl, parseDbParams, redisCliCommand, redisUrl, sqlcmdCommand } from "./params";
import { sessionUserSetup } from "./session-user";

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
    expect(dbParamsFrom({ database: "", databases: "a, b" }, "MSSQL")).toEqual({ database: "", databases: [], tls: "require", caCertPem: null, sessionRole: "" });
  });
  it("publishes its own port and a sqlcmd line", () => {
    expect(dbPublicPort("MSSQL")).toBe(11433);
    vi.stubEnv("MSSQL_PUBLIC_PORT", "1433");
    expect(dbPublicPort("MSSQL")).toBe(1433);
    expect(sqlcmdCommand({ host: "acme.cloud.captivo.io", port: 11433, ticket: "tk", database: "crm" })).toBe("sqlcmd -S tcp:acme.cloud.captivo.io,11433 -U tk -P x -d crm");
  });
});

describe("Redis and MongoDB database params", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("names and versions the engines", () => {
    expect(dbEngineOf("REDIS")).toBe("REDIS");
    expect(dbEngineOf("mongodb")).toBe("MONGODB");
    expect(dbEngineWire("REDIS")).toBe("redis");
    expect(dbEngineWire("MONGODB")).toBe("mongodb");
    expect(dbEngineLabel("MONGODB")).toBe("MongoDB");
    expect(dbMinConnector("REDIS")).toBe("2.64.0");
    expect(dbMinConnector("MONGODB")).toBe("2.64.0");
  });
  it("takes a database number for Redis and any name or none for MongoDB", () => {
    expect(dbParamsFrom({ database: "3" }, "REDIS")).toMatchObject({ database: "3", databases: [] });
    expect(dbParamsFrom({ database: "" }, "REDIS")).toMatchObject({ database: "" });
    expect(dbParamsFrom({ database: "crm" }, "REDIS")).toEqual({ error: "invalid_database" });
    expect(dbParamsFrom({ database: "1234" }, "REDIS")).toEqual({ error: "invalid_database" });
    expect(dbParamsFrom({ database: "", databases: "a" }, "MONGODB")).toMatchObject({ database: "", databases: [] });
    expect(dbParamsFrom({ database: "admin" }, "MONGODB")).toMatchObject({ database: "admin" });
    expect(parseDbParams({}, "REDIS").database).toBe("");
  });
  it("publishes their own ports and the client lines", () => {
    expect(dbPublicPort("REDIS")).toBe(16380);
    expect(dbPublicPort("MONGODB")).toBe(17017);
    vi.stubEnv("REDIS_PUBLIC_PORT", "6380");
    expect(dbPublicPort("REDIS")).toBe(6380);
    const t = { host: "acme.cloud.captivo.io", port: 16380, ticket: "tk" };
    expect(redisCliCommand(t)).toBe("redis-cli --tls -h acme.cloud.captivo.io -p 16380 --user tk --pass x");
    expect(redisUrl(t)).toBe("rediss://tk:x@acme.cloud.captivo.io:16380");
    expect(mongoUrl({ ...t, port: 17017 })).toBe("mongodb://tk:x@acme.cloud.captivo.io:17017/?tls=true&authMechanism=PLAIN&authSource=%24external");
    expect(mongoshCommand({ ...t, port: 17017 })).toContain('mongosh "mongodb://tk:x@');
  });
});

describe("session role", () => {
  it("is kept for PostgreSQL and MySQL only, and only as a plain role name", () => {
    expect(dbParamsFrom({ database: "app", sessionRole: " app_readonly " }, "POSTGRES")).toMatchObject({ sessionRole: "app_readonly" });
    expect(dbParamsFrom({ database: "", sessionRole: "reader" }, "MYSQL")).toMatchObject({ sessionRole: "reader" });
    expect(dbParamsFrom({ database: "", sessionRole: "reader" }, "MSSQL")).toEqual({ error: "invalid_session_role" });
    expect(dbParamsFrom({ database: "", sessionRole: "reader" }, "REDIS")).toEqual({ error: "invalid_session_role" });
    for (const bad of [`ro"x`, "a b", "x;DROP", "-lead"]) expect(dbParamsFrom({ database: "app", sessionRole: bad }, "POSTGRES")).toEqual({ error: "invalid_session_role" });
    expect(dbParamsFrom({ database: "app" }, "POSTGRES")).toMatchObject({ sessionRole: "" });
  });

  it("reads stored params back, ignoring a role an engine cannot use", () => {
    expect(parseDbParams({ database: "app", sessionRole: "r" }, "POSTGRES").sessionRole).toBe("r");
    expect(parseDbParams({ database: "app", sessionRole: "r" }, "MSSQL").sessionRole).toBe("");
    expect(parseDbParams({ database: "app", sessionRole: `a"b` }, "POSTGRES").sessionRole).toBe("");
  });

  it("shows the grants the saved account needs, quoted", () => {
    expect(sessionUserSetup("POSTGRES", "ro", `we"ird`)).toContain(`GRANT "ro" TO "we""ird" WITH ADMIN OPTION`);
    expect(sessionUserSetup("MYSQL", "ro", "prov")).toContain("GRANT CREATE USER, ROLE_ADMIN ON *.* TO 'prov'@'%'");
  });
});
