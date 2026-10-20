"use client";

import { useState } from "react";
import { filterUsers, type UserFilter } from "@/lib/admin/filter-users";
import { ROLE_LABELS, ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { ToggleStatusButton } from "./toggle-status-button";
import { DeleteUserButton } from "./delete-user-button";
import { RoleSelect } from "./role-select";
import { LocalTime } from "@/app/(app)/_shell/local-time";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  company: string | null;
  phone: string | null;
  role: string;
  status: string;
  passkeys: number;
  directoryManaged: boolean;
  /** The organisation role Captivo ID last reported; set = the centre manages this user. */
  centerRole: string | null;
  directoryLastVerifiedAt: string | null;
  isSelf: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  DISABLED: "Disabled",
};

const STATUS_PILL: Record<string, string> = {
  ACTIVE: "ok",
  DISABLED: "danger",
};

export function UsersTable({ users, initialQuery }: { users: UserRow[]; initialQuery: string }) {
  const [f, setF] = useState<UserFilter>({ q: initialQuery, status: "all", role: "all" });

  // Sync the search box when a new ⌘K deep-link changes ?q= while this component
  // stays mounted, without resetting the status/role selections. React's
  // store-previous-prop pattern (adjusting state during render) instead of an
  // effect — avoids the extra re-render and the set-state-in-effect lint rule.
  const [prevQuery, setPrevQuery] = useState(initialQuery);
  if (initialQuery !== prevQuery) {
    setPrevQuery(initialQuery);
    setF((prev) => ({ ...prev, q: initialQuery }));
  }

  const shown = filterUsers(users, f);

  return (
    <div>
      <div className="filters">
        <input
          className="input"
          placeholder="Search name or email…"
          value={f.q}
          onChange={(e) => setF({ ...f, q: e.target.value })}
        />
        <select
          className="select"
          value={f.status}
          onChange={(e) => setF({ ...f, status: e.target.value as UserFilter["status"] })}
        >
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="DISABLED">Disabled</option>
        </select>
        <select
          className="select"
          value={f.role}
          onChange={(e) => setF({ ...f, role: e.target.value as UserFilter["role"] })}
        >
          <option value="all">All roles</option>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <div className="empty">No matching users.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Role</th>
                <th>Status</th>
                <th>Passkeys</th>
                <th>Directory</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="cell-sub">{u.email}</td>
                  <td>
                    <div>{u.company ?? "—"}</div>
                    {u.phone && <div className="cell-sub">{u.phone}</div>}
                  </td>
                  <td><RoleSelect userId={u.id} role={u.role} disabled={u.isSelf} centerRole={u.centerRole} /></td>
                  <td>
                    <span className={`pill ${STATUS_PILL[u.status] ?? "neutral"}`}>
                      {STATUS_LABEL[u.status] ?? u.status}
                    </span>
                  </td>
                  <td className="cell-sub">{u.passkeys}</td>
                  <td className="cell-sub">
                    {u.directoryManaged
                      ? u.directoryLastVerifiedAt
                        ? <>Verified <LocalTime iso={new Date(u.directoryLastVerifiedAt).toISOString()} mode="date" /></>
                        : "Managed"
                      : "—"}
                  </td>
                  <td>
                    {u.isSelf ? (
                      <span className="cell-sub" title="You can't disable yourself">
                        (this account)
                      </span>
                    ) : u.centerRole ? (
                      <span className="cell-sub" title="Status and membership follow the Captivo organisation; remove the member on the Captivo account page.">
                        Captivo ID
                      </span>
                    ) : (
                      <>
                        <ToggleStatusButton userId={u.id} status={u.status} />
                        {u.role !== "ADMIN" && (
                          <span style={{ marginLeft: ".4rem" }}>
                            <DeleteUserButton userId={u.id} name={u.name} />
                          </span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
