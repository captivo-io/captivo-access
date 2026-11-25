import type { DbEngine } from "@/lib/database/params";

const pg = (s: string) => `"${s.replace(/"/g, '""')}"`;
const my = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/**
 * What the saved account needs to make a user per connection in `role`, as the
 * statements an admin runs once on the server (the resource form shows them).
 */
export function sessionUserSetup(engine: DbEngine, role: string, provisioner: string): string {
  if (engine === "MYSQL") {
    const u = `${my(provisioner)}@'%'`;
    return [
      "-- MySQL 8",
      `GRANT CREATE USER, ROLE_ADMIN ON *.* TO ${u};`,
      `GRANT SELECT ON mysql.user TO ${u};  -- lets it remove leftovers`,
      "-- MariaDB instead",
      `GRANT CREATE USER ON *.* TO ${u};`,
      `GRANT ${my(role)} TO ${u} WITH ADMIN OPTION;`,
      `GRANT UPDATE ON mysql.* TO ${u};  -- MariaDB sets another user's default role this way`,
      `GRANT SELECT ON mysql.user TO ${u};`,
    ].join("\n");
  }
  return [`ALTER ROLE ${pg(provisioner)} CREATEROLE;`, `GRANT ${pg(role)} TO ${pg(provisioner)} WITH ADMIN OPTION;`].join("\n");
}
