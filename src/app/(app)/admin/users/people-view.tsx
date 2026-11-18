"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { useZone, fmt, hm, dayKey } from "@/app/(app)/admin/audit/audit-zone";
import { filterUsers, type UserFilter } from "@/lib/admin/filter-users";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { Role } from "@/generated/prisma/enums";
import type { ConsoleSessionRow, InviteRowJSON, InviteState, PersonRow } from "@/lib/people/rows";
import { InviteDialogBody, OneTimeLink } from "./invite-dialog";

export type PeopleTab = "users" | "invites" | "sessions";
type Toast = { msg: string; ok: boolean } | null;

const SUBTITLE: Record<PeopleTab, string> = {
  users: "Everyone who can reach the console or resources. Change roles here; resource access is given on the Grants page.",
  invites: "Invitations you have sent. For security, an invite link is shown only once, when it is created.",
  sessions: "Who is signed in to this console, and on which device. This is not the resource sessions page.",
};

export const ROLE_INFO: Record<Role, string> = {
  ADMIN: "All settings, users and grants.",
  OPERATOR: "Gives access and watches sessions; can't change settings.",
  AUDITOR: "Reads the console and audit log; changes nothing.",
  STAFF: "Connects to the resources granted to them. No console.",
  VENDOR: "Connects only to the resources granted to them.",
  PLATFORM: "",
};
export const roleTone = (r: Role) => ({ ADMIN: "", OPERATOR: "p", AUDITOR: "ok", STAFF: "muted", VENDOR: "violet", PLATFORM: "" })[r];

export function initials(name: string, email: string): string {
  const parts = (name || email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** "Today 15:45", "Yesterday 09:10", "Nov 9, 14:02". */
function when(iso: string, zone: string, now: number): string {
  const k = dayKey(iso, zone);
  if (k === dayKey(new Date(now).toISOString(), zone)) return `Today ${hm(iso, zone)}`;
  if (k === dayKey(new Date(now - 86_400_000).toISOString(), zone)) return `Yesterday ${hm(iso, zone)}`;
  return `${date(iso, zone, now)}, ${hm(iso, zone)}`;
}
function date(iso: string, zone: string, now: number): string {
  const sameYear = fmt(iso, zone, { year: "numeric" }) === fmt(now, zone, { year: "numeric" });
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(iso));
}

export function PeopleView({
  workspace, initialTab, initialQuery, openInvite, people, invites, sessions, canEmail, inviteTtlHours, centerUrl, serverNow,
}: {
  workspace: string | null;
  initialTab: PeopleTab;
  initialQuery: string;
  openInvite: boolean;
  people: PersonRow[];
  invites: InviteRowJSON[];
  sessions: ConsoleSessionRow[];
  canEmail: boolean;
  inviteTtlHours: number;
  /** Set when the workspace belongs to a Captivo organisation: members are invited there. */
  centerUrl: string | null;
  serverNow: number;
}) {
  const router = useRouter();
  const zone = useZone();
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const [tab, setTab] = useState<PeopleTab>(initialTab);
  const [inviteOpen, setInviteOpen] = useState(openInvite);
  const [fresh, setFresh] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the tab in the address so a reload or a shared link lands on it.
  function pick(t: PeopleTab) {
    setTab(t);
    const u = new URL(window.location.href);
    if (t === "users") u.searchParams.delete("tab"); else u.searchParams.set("tab", t);
    u.searchParams.delete("new");
    window.history.replaceState(null, "", u);
  }

  const say = (msg: string, ok = true) => { setToast({ msg, ok }); if (ok) router.refresh(); };
  const counts = { users: people.length, invites: invites.length, sessions: sessions.length };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Identity &amp; access{workspace ? ` · ${workspace}` : ""}</div>
          <h1>People</h1>
          <p>{SUBTITLE[tab]}</p>
        </div>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={() => setInviteOpen(true)}>+ Invite</button>
        </div>
      </div>

      {centerUrl && (
        <p className="pp-note" role="note">
          This workspace belongs to a Captivo organisation. Its members (admins, operators, auditors, staff) are invited on the{" "}
          <a href={centerUrl}>Captivo account page</a>, and their roles can only be narrowed here. Invites from this page are for vendors.
        </p>
      )}

      <div className="pp-tabs" role="tablist" aria-label="People">
        {(["users", "invites", "sessions"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "pp-tab on" : "pp-tab"} onClick={() => pick(t)}>
            {t === "users" ? "Users" : t === "invites" ? "Invites" : "Console sessions"}
            <span className="pp-count">{counts[t]}</span>
          </button>
        ))}
      </div>

      {tab === "users" && <UsersTab people={people} initialQuery={initialQuery} zone={zone} now={now} say={say} canEmail={canEmail} />}
      {tab === "invites" && <InvitesTab invites={invites} fresh={fresh} zone={zone} now={now} say={say} />}
      {tab === "sessions" && <SessionsTab sessions={sessions} zone={zone} now={now} say={say} />}

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="New invite" subtitle="The person creates their account and passkey with the link." size="md">
        {inviteOpen && (
          <InviteDialogBody canEmail={canEmail} vendorOnly={!!centerUrl} ttlHours={inviteTtlHours}
            onClose={() => setInviteOpen(false)}
            onCreated={(id) => { setFresh(id); pick("invites"); say("Invite created"); }} />
        )}
      </Modal>

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "t-bad"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </>
  );
}

type Say = (msg: string, ok?: boolean) => void;

/* ---------------- Users ---------------- */

const ROLE_FILTERS: ("all" | Role)[] = ["all", "ADMIN", "OPERATOR", "AUDITOR", "STAFF", "VENDOR"];

type ResetLink = { email: string; link: string; emailed: boolean | null; removed: number };

function UsersTab({ people, initialQuery, zone, now, say, canEmail }: { people: PersonRow[]; initialQuery: string; zone: string; now: number; say: Say; canEmail: boolean }) {
  const [f, setF] = useState<UserFilter>({ q: initialQuery, status: "all", role: "all" });
  const [reset, setReset] = useState<ResetLink | null>(null);
  const shown = useMemo(() => filterUsers(people, f), [people, f]);
  const present = new Set(people.map((p) => p.role));
  return (
    <>
      <div className="pp-tools">
        <label className="ma-search">
          <SearchIcon />
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search name or email…" aria-label="Search people" />
        </label>
        <div className="seg" role="group" aria-label="Role">
          {ROLE_FILTERS.filter((r) => r === "all" || present.has(r) || ["ADMIN", "OPERATOR", "VENDOR"].includes(r)).map((r) => (
            <button key={r} type="button" className={f.role === r ? "seg-opt on" : "seg-opt"} aria-pressed={f.role === r} onClick={() => setF({ ...f, role: r })}>
              {r === "all" ? "All roles" : ROLE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Status">
          {(["all", "ACTIVE", "DISABLED"] as const).map((s) => (
            <button key={s} type="button" className={f.status === s ? "seg-opt on" : "seg-opt"} aria-pressed={f.status === s} onClick={() => setF({ ...f, status: s })}>
              {s === "all" ? "All" : s === "ACTIVE" ? "Active" : "Disabled"}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="au-empty"><b>No one matches these filters</b><button type="button" className="btn" onClick={() => setF({ q: "", status: "all", role: "all" })}>Clear filters</button></div>
      ) : (
        <div className="pp-card">
          <div className="pp-urow pp-cols" aria-hidden="true"><span>Person</span><span>Role</span><span>Sign-in</span><span>Last active</span><span>Status</span><span /></div>
          {shown.map((p) => <UserRow key={p.id} p={p} zone={zone} now={now} say={say} canEmail={canEmail} onReset={setReset} />)}
        </div>
      )}
      <Modal open={reset !== null} onClose={() => setReset(null)} title="New passkey link"
        subtitle={reset ? `${reset.removed} ${reset.removed === 1 ? "passkey" : "passkeys"} removed from ${reset.email}. They sign in again after registering a new one with this link.` : undefined} size="md">
        {reset && <OneTimeLink label="New passkey link" link={reset.link} emailed={reset.emailed} email={reset.email} onClose={() => setReset(null)} />}
      </Modal>
    </>
  );
}

function UserRow({ p, zone, now, say, canEmail, onReset }: { p: PersonRow; zone: string; now: number; say: Say; canEmail: boolean; onReset: (r: ResetLink) => void }) {
  const auth = p.source === "captivo"
    ? { main: "Captivo ID", warn: false }
    : p.passkeys > 0
      ? { main: `${p.passkeys} ${p.passkeys === 1 ? "passkey" : "passkeys"}`, warn: false }
      : { main: p.role === "VENDOR" ? "No passkey yet" : "No passkey", warn: p.role === "VENDOR" };
  const source = p.source === "captivo" ? "Organisation member" : p.source === "directory" ? "From the directory" : "Local account";
  return (
    <div className={p.status === "DISABLED" ? "pp-urow off" : "pp-urow"}>
      <span className="pp-who">
        <span className="pp-av" aria-hidden="true">{initials(p.name, p.email)}</span>
        <span className="pp-who-t">
          <span className="pp-who-n">{p.name || p.email}{p.isSelf && <span className="chip">YOU</span>}</span>
          <span className="mono t-muted">{p.email}</span>
        </span>
      </span>
      <RoleMenu p={p} say={say} />
      <span className="pp-auth">
        <span className={auth.warn ? "pp-auth-m t-warn" : "pp-auth-m"}><KeyIcon />{auth.main}</span>
        <span className="cell-sub">{source}</span>
      </span>
      <span className="pp-last">{p.isSelf ? "Now" : p.lastActive ? when(p.lastActive, zone, now) : "—"}</span>
      <span className={p.status === "ACTIVE" ? "pp-st ok" : "pp-st muted"}><span aria-hidden="true" />{p.status === "ACTIVE" ? "Active" : "Disabled"}</span>
      <UserMenu p={p} say={say} canEmail={canEmail} onReset={onReset} />
    </div>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

async function patchUser(id: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(`/api/admin/users/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => ({}));
    if (res.ok && r?.ok !== false) return null;
    return r?.error ?? "failed";
  } catch {
    return "failed";
  }
}

function userError(code: string): string {
  switch (code) {
    case "cannot_change_own_role": return "You can't change your own role.";
    case "center_role_ceiling": return "Their Captivo organisation role doesn't allow that role.";
    case "managed_by_center": return "This person is managed by their Captivo organisation.";
    case "cannot_disable_self": return "You can't disable your own account.";
    case "cannot_delete_admin": return "Admins can't be deleted. Change the role first.";
    default: return "That didn't work. Try again.";
  }
}

function RoleMenu({ p, say }: { p: PersonRow; say: Say }) {
  const { open, setOpen, ref } = usePopover();
  const [busy, setBusy] = useState(false);
  const locked = p.isSelf || p.roles.length <= 1;
  const pill = <span className={`pp-role ${roleTone(p.role)}`}>{ROLE_LABELS[p.role]}{!locked && <span className="pp-role-c" aria-hidden="true">⌄</span>}</span>;
  if (locked) return <span className="pp-role-wrap" title={p.isSelf ? "You can't change your own role" : undefined}>{pill}</span>;
  async function set(r: Role) {
    if (r === p.role) { setOpen(false); return; }
    setBusy(true);
    const err = await patchUser(p.id, { role: r });
    setBusy(false);
    setOpen(false);
    say(err ? userError(err) : `${p.name || p.email} is now ${ROLE_LABELS[r]}`, !err);
  }
  return (
    <div className="pp-role-wrap" ref={ref}>
      <button type="button" className="pp-role-btn" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((v) => !v)}>{pill}</button>
      {open && (
        <div className="pp-rmenu" role="menu">
          {p.roles.map((r) => (
            <button key={r} type="button" role="menuitemradio" aria-checked={r === p.role} className="pp-rmi" onClick={() => void set(r)}>
              <span className="pp-rmi-t"><b>{ROLE_LABELS[r]}</b><span className="cell-sub">{ROLE_INFO[r]}</span></span>
              {r === p.role && <span className="t-ok" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ p, say, canEmail, onReset }: { p: PersonRow; say: Say; canEmail: boolean; onReset: (r: ResetLink) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [confirm, setConfirm] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setConfirm(false); setConfirmReset(false); } }, [open]);
  const grant = p.status === "ACTIVE";
  if (!grant && !p.canToggle && !p.canDelete && !p.canReset) return <span />;

  async function resetPasskeys() {
    setBusy(true);
    let r: { link?: string; emailed?: boolean | null; removed?: number; error?: string } = {};
    try {
      const res = await fetch(`/api/admin/users/${p.id}/reset-passkeys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sendEmail: canEmail }) });
      r = await res.json().catch(() => ({}));
    } catch { /* reported below */ }
    setBusy(false);
    setOpen(false);
    if (r.link) {
      onReset({ email: p.email, link: r.link, emailed: r.emailed ?? null, removed: r.removed ?? 0 });
      say(`Passkeys reset for ${p.name || p.email}`);
    } else {
      say(r.error === "managed_by_center" ? "This person signs in through their Captivo organisation." : "Couldn't reset the passkeys. Try again.", false);
    }
  }

  async function toggle() {
    setBusy(true);
    const next = p.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    const err = await patchUser(p.id, { status: next });
    setBusy(false);
    setOpen(false);
    say(err ? userError(err) : next === "DISABLED" ? `${p.name || p.email} can no longer sign in` : `${p.name || p.email} can sign in again`, !err);
  }
  async function del() {
    setBusy(true);
    let err: string | null = null;
    try {
      const res = await fetch(`/api/admin/users/${p.id}`, { method: "DELETE" });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) err = r?.error ?? "failed";
    } catch { err = "failed"; }
    setBusy(false);
    setOpen(false);
    say(err ? userError(err) : `${p.name || p.email} deleted`, !err);
  }
  return (
    <div className="rs-menu pp-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label={`Actions for ${p.name || p.email}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="rs-menu-pop" role="menu">
          {grant && <Link role="menuitem" className="rs-mi" href={`/admin/grants?new=1&user=${encodeURIComponent(p.id)}`}>Grant access</Link>}
          {p.canReset && (confirmReset ? (
            <button type="button" role="menuitem" className="rs-mi danger-solid" disabled={busy} onClick={() => void resetPasskeys()}>
              {busy ? "Resetting…" : p.passkeys > 0 ? `Sure? Remove ${p.passkeys} ${p.passkeys === 1 ? "passkey" : "passkeys"}` : "Sure? Make a passkey link"}
            </button>
          ) : (
            <button type="button" role="menuitem" className="rs-mi" title="Removes their passkeys and signs them out; you get a one-time link for a new passkey" onClick={() => setConfirmReset(true)}>Reset passkeys</button>
          ))}
          {p.canToggle && (
            <button type="button" role="menuitem" className="rs-mi" disabled={busy} onClick={() => void toggle()}>{p.status === "ACTIVE" ? "Disable" : "Enable"}</button>
          )}
          {p.canDelete && (
            <>
              <hr />
              {confirm ? (
                <button type="button" role="menuitem" className="rs-mi danger-solid" disabled={busy} onClick={() => void del()}>{busy ? "Deleting…" : "Sure? Delete user"}</button>
              ) : (
                <button type="button" role="menuitem" className="rs-mi danger" onClick={() => setConfirm(true)}>Delete user</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Invites ---------------- */

const INVITE_FILTERS: { key: "all" | InviteState; label: string }[] = [
  { key: "all", label: "All" }, { key: "pending", label: "Pending" }, { key: "used", label: "Used" }, { key: "expired", label: "Expired" },
];
const INVITE_PILL: Record<InviteState, { cls: string; label: string }> = {
  pending: { cls: "warn", label: "Pending" }, used: { cls: "ok", label: "Used" }, expired: { cls: "muted", label: "Expired" },
};

function InvitesTab({ invites, fresh, zone, now, say }: { invites: InviteRowJSON[]; fresh: string | null; zone: string; now: number; say: Say }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<"all" | InviteState>("all");
  const [link, setLink] = useState<{ email: string; link: string; emailed: boolean | null } | null>(null);
  const t = q.trim().toLowerCase();
  const matchQ = (i: InviteRowJSON) => !t || [i.name, i.email, i.company, ROLE_LABELS[i.role]].some((v) => v?.toLowerCase().includes(t));
  const count = (s: "all" | InviteState) => invites.filter((i) => matchQ(i) && (s === "all" || i.state === s)).length;
  const shown = invites.filter((i) => matchQ(i) && (state === "all" || i.state === state));
  return (
    <>
      <div className="pp-tools">
        <label className="ma-search">
          <SearchIcon />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, company or role…" aria-label="Search invites" />
        </label>
        <div className="seg" role="group" aria-label="Status">
          {INVITE_FILTERS.map((f) => (
            <button key={f.key} type="button" className={state === f.key ? "seg-opt on" : "seg-opt"} aria-pressed={state === f.key} onClick={() => setState(f.key)}>
              {f.label}<span className="mono t-muted">{count(f.key)}</span>
            </button>
          ))}
        </div>
      </div>
      {invites.length === 0 ? (
        <div className="au-empty"><b>No invites yet</b><span className="cell-sub">Invite a vendor or a colleague with “+ Invite”. They create their own passkey with the link.</span></div>
      ) : shown.length === 0 ? (
        <div className="au-empty"><b>No invites match these filters</b><button type="button" className="btn" onClick={() => { setQ(""); setState("all"); }}>Clear filters</button></div>
      ) : (
        <div className="pp-card">
          {shown.map((i) => (
            <div key={i.id} className={i.id === fresh ? "pp-irow fresh" : "pp-irow"}>
              <span className="pp-who">
                <span className="pp-tile" aria-hidden="true"><MailIcon /></span>
                <span className="pp-who-t">
                  <span className="pp-who-n">{i.name || i.email}</span>
                  <span className="mono t-muted">{[i.email, i.company].filter(Boolean).join(" · ")}</span>
                </span>
              </span>
              <span className="pp-rchip">{ROLE_LABELS[i.role].toUpperCase()}</span>
              <span className="pp-when">
                <span>{i.state === "used" && i.usedAt ? `Used ${date(i.usedAt, zone, now)}` : `${i.state === "expired" ? "Expired" : "Expires"} ${when(i.expiresAt, zone, now)}`}</span>
                <span className="cell-sub">{i.invitedBy ? `Invited by ${i.invitedBy}` : `Created ${date(i.createdAt, zone, now)}`}</span>
              </span>
              <span className={`pp-st ${INVITE_PILL[i.state].cls}`}><span aria-hidden="true" />{INVITE_PILL[i.state].label}</span>
              {i.state === "used" ? <span /> : <InviteMenu i={i} say={say} onLink={setLink} />}
            </div>
          ))}
        </div>
      )}
      <p className="pp-foot"><LockIcon />Links are shown only when they are created. If one is lost, make a new link.</p>
      <Modal open={link !== null} onClose={() => setLink(null)} title="New link ready" subtitle={link ? `For ${link.email}. The old link no longer works.` : undefined} size="md">
        {link && <OneTimeLink link={link.link} emailed={link.emailed} email={link.email} onClose={() => setLink(null)} />}
      </Modal>
    </>
  );
}

function InviteMenu({ i, say, onLink }: { i: InviteRowJSON; say: Say; onLink: (l: { email: string; link: string; emailed: boolean | null }) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) setConfirm(false); }, [open]);
  async function regenerate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/invites/${i.id}/resend`, { method: "POST" });
      const r = await res.json().catch(() => ({}));
      if (res.ok && r?.link) { setOpen(false); onLink({ email: i.email, link: r.link, emailed: r.emailed ?? null }); say("New link created"); return; }
      say(r?.error === "already_used" ? "This invite was just used." : "Couldn't make a new link. Try again.", false);
    } catch {
      say("Couldn't make a new link. Try again.", false);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/invites/${i.id}`, { method: "DELETE" });
      setOpen(false);
      say(res.ok ? "Invite cancelled" : "Couldn't cancel the invite. Try again.", res.ok);
    } catch {
      say("Couldn't cancel the invite. Try again.", false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rs-menu pp-menu" ref={ref}>
      <button type="button" className="btn sm rs-more" aria-label={`Actions for the invite to ${i.email}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="rs-menu-pop" role="menu">
          <button type="button" role="menuitem" className="rs-mi" disabled={busy} onClick={() => void regenerate()}>Make a new link</button>
          <hr />
          {confirm ? (
            <button type="button" role="menuitem" className="rs-mi danger-solid" disabled={busy} onClick={() => void cancel()}>Sure? Cancel invite</button>
          ) : (
            <button type="button" role="menuitem" className="rs-mi danger" onClick={() => setConfirm(true)}>Cancel invite</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Console sessions ---------------- */

function SessionsTab({ sessions, zone, now, say }: { sessions: ConsoleSessionRow[]; zone: string; now: number; say: Say }) {
  const [q, setQ] = useState("");
  const [askAll, setAskAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const t = q.trim().toLowerCase();
  const shown = sessions.filter((s) => !t || [s.userName, s.userEmail, s.ip, s.device, s.userAgent].some((v) => v?.toLowerCase().includes(t)));
  const others = sessions.filter((s) => !s.current).map((s) => s.id);

  async function signOutOthers() {
    setBusyAll(true);
    try {
      const res = await fetch("/api/admin/sessions/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: others }) });
      say(res.ok ? `${others.length} ${others.length === 1 ? "session" : "sessions"} signed out` : "Couldn't sign them out. Try again.", res.ok);
    } catch {
      say("Couldn't sign them out. Try again.", false);
    } finally {
      setBusyAll(false);
      setAskAll(false);
    }
  }

  return (
    <>
      <div className="pp-tools">
        <label className="ma-search">
          <SearchIcon />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search person, IP or browser…" aria-label="Search console sessions" />
        </label>
        {askAll ? (
          <button type="button" className="btn danger" disabled={busyAll} onClick={() => void signOutOthers()}>{busyAll ? "Signing out…" : `Sign out ${others.length} other ${others.length === 1 ? "session" : "sessions"}?`}</button>
        ) : (
          <button type="button" className="btn pp-danger-outline" disabled={others.length === 0} onClick={() => setAskAll(true)}>Sign out all other sessions</button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="au-empty"><b>No sessions match</b></div>
      ) : (
        <div className="pp-sgrid">
          {shown.map((s) => <SessionCard key={s.id} s={s} zone={zone} now={now} say={say} />)}
        </div>
      )}
    </>
  );
}

function SessionCard({ s, zone, now, say }: { s: ConsoleSessionRow; zone: string; now: number; say: Say }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function end() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sessions/${s.id}`, { method: "DELETE" });
      say(res.ok ? `${s.userName || s.userEmail} signed out on ${s.device ?? "that device"}` : "Couldn't sign it out. Try again.", res.ok);
    } catch {
      say("Couldn't sign it out. Try again.", false);
    } finally {
      setBusy(false);
      setAsk(false);
    }
  }
  return (
    <section className={s.current ? "pp-scard me" : "pp-scard"}>
      <div className="pp-scard-h">
        <span className="pp-tile" aria-hidden="true">{s.mobile ? <PhoneIcon /> : <DesktopIcon />}</span>
        <span className="pp-who-t">
          <span className="pp-who-n" title={s.userAgent ?? undefined}>{s.device ?? "Unknown browser"}{s.current && <span className="pp-me">● This device</span>}</span>
          <span className="cell-sub">{s.userName || s.userEmail} · {s.userEmail}</span>
        </span>
      </div>
      <div className="pp-strip">
        <span><span className="pp-k">IP</span><span className="mono">{s.ip ?? "—"}</span></span>
        <span><span className="pp-k">Started</span><span className="mono">{when(s.startedAt, zone, now)}</span></span>
        <span><span className="pp-k">Last active</span><span className="mono">{s.current ? "Now" : when(s.lastSeenAt, zone, now)}</span></span>
      </div>
      <div className="pp-scard-f">
        <span className="chip neutral">{s.signIn}</span>
        {s.current ? (
          <button type="button" className="btn sm" disabled title="Close your own session by signing out">Sign out</button>
        ) : ask ? (
          <span className="row-actions">
            <button type="button" className="btn sm" onClick={() => setAsk(false)}>Keep</button>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => void end()}>{busy ? "Signing out…" : "Sign out now"}</button>
          </span>
        ) : (
          <button type="button" className="btn sm" onClick={() => setAsk(true)}>Sign out</button>
        )}
      </div>
    </section>
  );
}

/* ---------------- icons ---------------- */

const svg = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function SearchIcon() { return <svg {...svg}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>; }
function KeyIcon() { return <svg {...svg} width={14} height={14}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></svg>; }
function MailIcon() { return <svg {...svg}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>; }
function LockIcon() { return <svg {...svg} width={13} height={13}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>; }
function DesktopIcon() { return <svg {...svg} width={17} height={17}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>; }
function PhoneIcon() { return <svg {...svg} width={17} height={17}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>; }
