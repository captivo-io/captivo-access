import { describe, expect, it } from "vitest";
import { riskyReason } from "./risky";

describe("riskyReason", () => {
  it("flags destructive and permission statements", () => {
    expect(riskyReason("DROP TABLE users")).toBe("Drops an object");
    expect(riskyReason("ALTER LOGIN app WITH PASSWORD = N'***'")).toBe("Creates or changes a login");
    expect(riskyReason("EXEC xp_cmdshell 'dir c:\\'")).toBe("Runs a program on the server");
    expect(riskyReason("SELECT * FROM OPENROWSET(BULK 'c:\\x.csv', SINGLE_CLOB) AS t")).toBe("Reads files or other servers");
    expect(riskyReason("EXEC sp_configure 'show advanced options', 1")).toBe("Changes the server's configuration");
    expect(riskyReason("truncate orders")).toBe("Empties a table");
    expect(riskyReason("DELETE FROM orders")).toBe("Deletes every row");
    expect(riskyReason("delete from orders;")).toBe("Deletes every row");
    expect(riskyReason("update customers set email = lower(email);\n")).toBe("Changes every row");
    expect(riskyReason("update accounts set balance = 0")).toBe("Changes every row");
    expect(riskyReason("GRANT ALL ON ALL TABLES IN SCHEMA public TO bob")).toBe("Changes permissions");
    expect(riskyReason("/* tool */ -- note\nDROP SCHEMA x CASCADE")).toBe("Drops an object");
    expect(riskyReason("SELECT * FROM users INTO OUTFILE '/tmp/u.csv'")).toBe("Writes a file on the server");
    expect(riskyReason("ALTER USER 'app'@'%' IDENTIFIED BY '***'")).toBe("Changes the schema or a role");
  });
  it("leaves ordinary statements alone", () => {
    expect(riskyReason("SELECT * FROM users")).toBeNull();
    expect(riskyReason("DELETE FROM orders WHERE id = $1")).toBeNull();
    expect(riskyReason("UPDATE accounts SET balance = 0 WHERE id = 3")).toBeNull();
    expect(riskyReason("INSERT INTO t VALUES (1)")).toBeNull();
  });
});
