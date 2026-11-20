"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";

// Connector groups on the Connectors page: several connectors that serve the
// same resources. Sessions are spread over the online active members; standby
// members carry them only while no active member is online.

export type GroupMemberCard = {
  id: string;
  name: string;
  status: string;
  version: string | null;
  standby: boolean;
  /** Live sessions it carries now (telemetry); null when not known. */
  sessions: number | null;
  /** Resources it cannot open the password of (sealed before it joined). */
  noSeal: string[];
  /** Resources the health probe last saw it fail to reach. */
  unreachable: string[];
};

export type GroupCard = { id: string; name: string; members: GroupMemberCard[]; resources: string[] };
export type PickableConnector = { id: string; name: string; status: string };

const ERRORS: Record<string, string> = {
  invalid_name: "Give the group a name of up to 60 characters.",
  name_taken: "Another group already has this name.",
  no_members: "Choose at least one connector.",
  no_active_member: "At least one member must be active; standby members only take over.",
  too_many_members: "A group can have up to 16 connectors.",
  connector_not_found: "One of the connectors is gone or revoked. Reload the page.",
  group_in_use: "Move this group's resources to a connector or another group first.",
};

export function GroupsPanel({ groups, connectors }: { groups: GroupCard[]; connectors: PickableConnector[] }) {
  const [editing, setEditing] = useState<GroupCard | "new" | null>(null);
  const eligible = connectors.filter((c) => c.status !== "REVOKED");

  return (
    <section className="cg" aria-labelledby="cg-title">
      <div className="cg-head">
        <div>
          <h2 id="cg-title">Connector groups</h2>
          <p className="cell-sub">
            Run two or more connectors in the same network and put them in a group. A resource on a group keeps
            working when one connector goes down, and its sessions are spread over the connectors that are up.
          </p>
        </div>
        <button type="button" className="btn sm" disabled={eligible.length === 0} onClick={() => setEditing("new")}>
          + New group
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="cg-empty">
          <span className="cg-empty-ic" aria-hidden="true"><NavIcon name="plug" size={18} /></span>
          <span>
            No groups yet. {eligible.length < 2
              ? "Install a second connector in the same network, then group the two."
              : "Group connectors that reach the same machines, then choose the group on a resource instead of a single connector."}
          </span>
        </div>
      ) : (
        <div className="cg-list">
          {groups.map((g) => <Group key={g.id} g={g} onEdit={() => setEditing(g)} />)}
        </div>
      )}

      {editing && <GroupDialog group={editing === "new" ? null : editing} connectors={eligible} onClose={() => setEditing(null)} />}
    </section>
  );
}

function Group({ g, onEdit }: { g: GroupCard; onEdit: () => void }) {
  const online = g.members.filter((m) => m.status === "ONLINE");
  const activeUp = online.filter((m) => !m.standby).length;
  const state = online.length === 0 ? ["down", "No member online"] : activeUp === 0 ? ["warn", "Running on standby"] : online.length < g.members.length ? ["warn", `${online.length} of ${g.members.length} online`] : ["up", "All online"];
  const issues = g.members.filter((m) => m.noSeal.length || m.unreachable.length);
  return (
    <article className="cg-card">
      <div className="cg-top">
        <div className="cg-id">
          <b>{g.name}</b>
          <span className="cell-sub">{g.members.length} connector{g.members.length === 1 ? "" : "s"} · {g.resources.length} resource{g.resources.length === 1 ? "" : "s"}</span>
        </div>
        <span className={`rs-pill ${state[0]}`}><span className="rs-pdot" aria-hidden="true" /> {state[1]}</span>
        <button type="button" className="btn sm" onClick={onEdit}>Edit</button>
      </div>
      <ul className="cg-members">
        {g.members.map((m) => (
          <li key={m.id} className={m.status === "ONLINE" ? "cg-m" : "cg-m off"}>
            <span className={m.status === "ONLINE" ? "cg-dot on" : "cg-dot"} aria-hidden="true" />
            <span className="cg-m-name" title={m.name}>{m.name}</span>
            <span className={m.standby ? "chip neutral" : "chip ok"}>{m.standby ? "standby" : "active"}</span>
            <span className="cg-m-load mono">{m.status !== "ONLINE" ? (m.status === "REVOKED" ? "revoked" : "offline") : m.sessions == null ? "—" : `${m.sessions} session${m.sessions === 1 ? "" : "s"}`}</span>
          </li>
        ))}
      </ul>
      {issues.length > 0 && (
        <ul className="cg-issues">
          {issues.map((m) => (
            <li key={m.id}>
              {m.noSeal.length > 0 && (
                <span><b>{m.name}</b> can&apos;t open the saved password of {list(m.noSeal)}. Enter the password again on {m.noSeal.length === 1 ? "that resource" : "those resources"} and it is saved for every member; until then their sessions go through the others.</span>
              )}
              {m.unreachable.length > 0 && (
                <span><b>{m.name}</b> can&apos;t reach {list(m.unreachable)}. Sessions to {m.unreachable.length === 1 ? "it" : "them"} go through the other members until it can.</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function list(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

function GroupDialog({ group, connectors, onClose }: { group: GroupCard | null; connectors: PickableConnector[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState<Record<string, "active" | "standby">>(
    () => Object.fromEntries((group?.members ?? []).filter((m) => m.status !== "REVOKED").map((m) => [m.id, m.standby ? "standby" : "active"])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = Object.entries(members);
  const inUse = (group?.resources.length ?? 0) > 0;

  async function send(method: "POST" | "PATCH" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      const url = group ? `/api/admin/connector-groups/${encodeURIComponent(group.id)}` : "/api/admin/connector-groups";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ name, members: chosen.map(([connectorId, role]) => ({ connectorId, standby: role === "standby" })) }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError((out.error && ERRORS[out.error]) || "Couldn't save the group, please try again.");
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Couldn't save the group, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={group ? `Edit ${group.name}` : "New connector group"} subtitle="Members must reach the same machines: any of them may carry a session." size="md">
      <label className="cg-field">
        <span>Name</span>
        <input className="input" value={name} maxLength={60} placeholder="e.g. Istanbul DC" onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="cg-field">
        <span>Members</span>
        <ul className="cg-pick">
          {[...connectors].sort((a, b) => a.name.localeCompare(b.name)).map((c) => {
            const role = members[c.id];
            return (
              <li key={c.id} className={role ? "on" : ""}>
                <label className="cg-pick-c">
                  <input type="checkbox" checked={!!role} onChange={(e) => setMembers((m) => {
                    const next = { ...m };
                    if (e.target.checked) next[c.id] = "active";
                    else delete next[c.id];
                    return next;
                  })} />
                  <span className={c.status === "ONLINE" ? "cg-dot on" : "cg-dot"} aria-hidden="true" />
                  <span className="cg-m-name">{c.name}</span>
                </label>
                {role && (
                  <div className="seg cg-role" role="group" aria-label={`${c.name} role`}>
                    {(["active", "standby"] as const).map((r) => (
                      <button key={r} type="button" className={role === r ? "seg-opt on" : "seg-opt"} aria-pressed={role === r} onClick={() => setMembers((m) => ({ ...m, [c.id]: r }))}>
                        {r === "active" ? "Active" : "Standby"}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="cell-sub cg-hint">
          Active members share the sessions. A standby member is used only while no active member is online.
          A member that joins later can&apos;t open passwords saved before it joined; the group shows which ones to enter again.
        </p>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="rq-foot">
        {group ? (
          <button type="button" className="btn danger" disabled={busy || inUse} title={inUse ? "Move its resources to a connector or another group first" : undefined} onClick={() => void send("DELETE")}>
            Delete group
          </button>
        ) : <span className="rq-status" />}
        <span className="rq-status" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn ink" disabled={busy || !name.trim() || chosen.length === 0} onClick={() => void send(group ? "PATCH" : "POST")}>
          {busy ? "Saving…" : group ? "Save" : "Create group"}
        </button>
      </div>
      {group && inUse && <p className="cell-sub cg-hint">{group.resources.length} resource{group.resources.length === 1 ? " uses" : "s use"} this group, so it can&apos;t be deleted yet.</p>}
    </Modal>
  );
}
