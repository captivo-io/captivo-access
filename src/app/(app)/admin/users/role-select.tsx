"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABELS, ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { centerRoleOf, consoleRolesFor } from "@/lib/auth/center-role";

export function RoleSelect({ userId, role, disabled, centerRole }: { userId: string; role: string; disabled?: boolean; centerRole?: string | null }) {
  // Under the centre's ceiling for an organisation member; every assignable role otherwise.
  const options = centerRole ? consoleRolesFor(centerRoleOf(centerRole)) : ASSIGNABLE_ROLES;
  const router = useRouter();
  const [value, setValue] = useState(role);
  const [busy, setBusy] = useState(false);
  async function onChange(next: string) {
    setValue(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      if (res.ok) router.refresh();
      else setValue(role); // revert on failure
    } finally {
      setBusy(false);
    }
  }
  return (
    <select className="select" value={value} disabled={disabled || busy} onChange={(e) => onChange(e.target.value)}>
      {options.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  );
}
