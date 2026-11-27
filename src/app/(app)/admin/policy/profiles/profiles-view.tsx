"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { MAX_COMMAND_LISTS } from "@/lib/policy/command-lists";

export type ListRow = { id: string; name: string; description: string | null; mode: "allow" | "deny"; entries: string[]; resources: number; profiles: number; direct: number };
export type ProfileRow = {
  id: string; name: string; description: string | null; recordSessions: boolean; keystrokeLogging: boolean; clipboardMode: string | null; watermark: boolean | null;
  fileTransferMode: string | null; egressMode: string | null; egressHosts: string[]; requireModerator: boolean; passwordCheckout: boolean; checkoutMaxMinutes: number;
  commandListId: string | null; resources: number; resourceNames: string[];
};

const CLIP: [string, string][] = [["", "Policy"], ["allow", "Copy & paste"], ["no_paste", "Copy only"], ["no_copy", "Paste only"], ["none", "Block"]];
const FT: [string, string][] = [["", "Policy"], ["allow", "Upload & download"], ["no_download", "Upload only"], ["no_upload", "Download only"], ["none", "Block"]];
const EGRESS: [string, string][] = [["", "Policy"], ["internet", "The resource and the internet"], ["strict", "Only listed hosts"], ["open", "Unrestricted"]];
const WM: [string, string][] = [["", "Policy"], ["on", "On"], ["off", "Off"]];
const LENGTHS: [string, string][] = [["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["240", "4 hours"], ["480", "8 hours"], ["1440", "24 hours"]];
const label = (opts: [string, string][], v: string | null) => opts.find(([k]) => k === (v ?? ""))?.[1] ?? "Policy";

const ERRORS: Record<string, string> = {
  invalid_name: "Give it a name.", name_too_long: "The name can be at most 48 characters.", name_taken: "Another one already has that name.",
  invalid_mode: "Pick allow or block.", invalid_entries: "Enter one command per line.", too_many_entries: "At most 200 entries.", entry_too_long: "An entry can be at most 200 characters.",
  entry_has_control: "An entry can't contain control characters.", too_many_lists: `At most ${MAX_COMMAND_LISTS} command lists.`, too_many_profiles: "At most 50 profiles.",
  invalid_egress_hosts: "Allowed hosts must be host names (sso.example.com, *.okta.com) or IP addresses.", invalid_checkout_minutes: "Pick one of the check-out lengths.",
  unknown_command_list: "That command list no longer exists.", forbidden: "Admin privileges are required.",
};
const errText = (code?: string) => (code && ERRORS[code]) || "Couldn't save. Try again.";

const n = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

function Switch({ on, onChange, label: l }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={l} className={on ? "toggle on" : "toggle"} onClick={() => onChange(!on)}><span /></button>;
}
function Seg({ value, onChange, options, label: l }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <div className="seg pf-seg" role="radiogroup" aria-label={l}>
      {options.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "seg-opt on" : "seg-opt"} onClick={() => onChange(v)}>{t}</button>)}
    </div>
  );
}
function Field({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return <div className="pf-field"><div className="pf-field-t"><b>{title}</b>{desc && <span className="cell-sub">{desc}</span>}</div><div className="pf-field-c">{children}</div></div>;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const SLIDERS = "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6";
const LIST = "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01";

type Cell = { l: string; v: string; dot: "ok" | "warn" | "bad" | "off" };

function profileCells(p: ProfileRow, lists: ListRow[]): Cell[] {
  const list = lists.find((l) => l.id === p.commandListId);
  const cells: Cell[] = [
    { l: "RECORDING", v: p.recordSessions ? "On" : "Off", dot: p.recordSessions ? "ok" : "off" },
    { l: "KEYSTROKES", v: p.keystrokeLogging ? "Logged" : "Not logged", dot: p.keystrokeLogging ? "ok" : "off" },
    { l: "CLIPBOARD", v: p.clipboardMode === "allow" ? "Allowed" : p.clipboardMode === "none" ? "Blocked" : label(CLIP, p.clipboardMode), dot: !p.clipboardMode ? "off" : p.clipboardMode === "allow" ? "ok" : "warn" },
    { l: "COMMANDS", v: list ? list.name : "No list", dot: !list ? "off" : list.mode === "allow" ? "ok" : "bad" },
  ];
  if (p.watermark !== null) cells.push({ l: "WATERMARK", v: p.watermark ? "On" : "Off", dot: p.watermark ? "ok" : "off" });
  if (p.fileTransferMode) cells.push({ l: "FILE TRANSFER", v: label(FT, p.fileTransferMode), dot: p.fileTransferMode === "allow" ? "ok" : "warn" });
  if (p.egressMode) cells.push({ l: "NETWORK", v: p.egressMode === "strict" ? `Listed hosts (${p.egressHosts.length})` : label(EGRESS, p.egressMode), dot: p.egressMode === "strict" ? "warn" : "ok" });
  if (p.requireModerator) cells.push({ l: "MODERATOR", v: "Required", dot: "ok" });
  if (p.passwordCheckout) cells.push({ l: "CHECK-OUT", v: `On · ${label(LENGTHS, String(p.checkoutMaxMinutes))}`, dot: "ok" });
  return cells;
}

function listSummary(l: ListRow): string {
  const c = l.entries.length;
  if (c === 0) return "No commands yet";
  if (l.mode === "allow") return c === 1 ? "Only this command runs" : `Only these ${c} commands run`;
  return c === 1 ? "Everything runs except this command" : `Everything runs except these ${c} commands`;
}

type Ask = { kind: "profiles" | "command-lists"; id: string } | null;

export function ProfilesView({ workspace, profiles, lists }: { workspace: string | null; profiles: ProfileRow[]; lists: ListRow[] }) {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileRow | "new" | null>(null);
  const [list, setList] = useState<ListRow | "new" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAsk(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask]);

  async function remove(kind: "profiles" | "command-lists", id: string) {
    setProblem(null);
    const res = await fetch(`/api/admin/policy/${kind}/${id}`, { method: "DELETE" });
    const r = await res.json().catch(() => ({}));
    if (res.ok) { setAsk(null); setToast("Deleted"); router.refresh(); return; }
    setProblem(r?.error === "in_use" ? "It is in use now. Move what uses it first." : errText(r?.error));
  }

  const onProfile = profiles.reduce((a, p) => a + p.resources, 0);
  const full = lists.length >= MAX_COMMAND_LISTS;

  const confirmBar = (kind: "profiles" | "command-lists", id: string, name: string, usedBy: string | null) => (
    <div className="pr-ask" role="alert">
      <span className="pr-ask-t">
        {usedBy ? <><b>Can&apos;t delete “{name}”.</b> {usedBy}</> : <><b>Delete “{name}”?</b> {kind === "profiles" ? "No resource follows it." : "Nothing uses it."}</>}
        {problem && <> <span className="pr-bad">{problem}</span></>}
      </span>
      <span className="pr-ask-b">
        <button type="button" className="btn sm" onClick={() => { setAsk(null); setProblem(null); }}>Cancel</button>
        {!usedBy && <button type="button" className="pr-danger" onClick={() => void remove(kind, id)}>Delete</button>}
      </span>
    </div>
  );

  return (
    <div className="pr">
      <div className="pol-head">
        <div className="eyebrow">INFRASTRUCTURE{workspace ? ` · ${workspace.toUpperCase()}` : ""}</div>
        <h1>Profiles & lists</h1>
        <p>Name a set of session settings once and give it to any number of resources. Add allow or block lists of commands for the resources that need them.</p>
      </div>

      <div className="pr-kpis">
        <div><span>POLICY PROFILES</span><b>{profiles.length}</b></div>
        <div><span>RESOURCES ON A PROFILE</span><b>{onProfile}</b></div>
        <div><span>COMMAND LISTS</span><b>{lists.length}<small>of {MAX_COMMAND_LISTS}</small></b></div>
      </div>

      <section className="pr-card" id="profiles" aria-labelledby="profiles-t">
        <div className="pr-card-h">
          <span className="pr-ic"><Icon d={SLIDERS} /></span>
          <div className="pr-card-t"><h2 id="profiles-t">Policy profiles</h2><p>A resource that follows a profile takes its settings. Change the profile and every resource that follows it changes too; sessions already open keep theirs.</p></div>
          <button type="button" className="pr-new" onClick={() => setProfile("new")}>+ New profile</button>
        </div>
        {profiles.length === 0 ? (
          <div className="pr-empty">
            <b>No profiles yet</b><span>Create a profile to set recording, keystrokes, clipboard and commands once for many resources.</span>
            <button type="button" className="btn" onClick={() => setProfile("new")}>+ New profile</button>
          </div>
        ) : profiles.map((p) => (
          <div key={p.id} className="pr-row">
            <div className="pr-id">
              <b>{p.name}</b>
              <span className="pr-res">
                <span>{p.resources === 0 ? "No resources yet" : n(p.resources, "resource", "resources")}</span>
                {p.resourceNames.slice(0, 3).map((r) => <span key={r} className="pr-chip">{r}</span>)}
                {p.resourceNames.length > 3 && <span className="pr-more">+{p.resourceNames.length - 3}</span>}
              </span>
              {p.description && <span className="pr-note">{p.description}</span>}
            </div>
            <dl className="pr-cells">
              {profileCells(p, lists).map((c) => (
                <div key={c.l}><dt>{c.l}</dt><dd><i className={`pr-dot ${c.dot}`} aria-hidden="true" /><span>{c.v}</span></dd></div>
              ))}
            </dl>
            <div className="pr-acts">
              <button type="button" className="btn sm pr-edit" onClick={() => setProfile(p)}>Edit</button>
              <button type="button" className="btn sm pr-del" aria-label={`Delete ${p.name}`} onClick={() => { setProblem(null); setAsk({ kind: "profiles", id: p.id }); }}>Delete</button>
            </div>
            {ask?.kind === "profiles" && ask.id === p.id && confirmBar("profiles", p.id, p.name, p.resources > 0 ? `${n(p.resources, "resource follows", "resources follow")} it. Move ${p.resources === 1 ? "it" : "them"} to another profile first.` : null)}
          </div>
        ))}
      </section>

      <section className="pr-card" id="lists" aria-labelledby="lists-t">
        <div className="pr-card-h">
          <span className="pr-ic"><Icon d={LIST} /></span>
          <div className="pr-card-t"><h2 id="lists-t">Command lists</h2><p>An allow list lets only the commands it names run. A block list lets everything run except the commands it names.</p></div>
          <span className="pr-card-r">
            <span className="pr-count">{lists.length} / {MAX_COMMAND_LISTS}</span>
            {full ? <span className="pr-full">Limit of {MAX_COMMAND_LISTS} reached</span> : <button type="button" className="pr-new" onClick={() => setList("new")}>+ New list</button>}
          </span>
        </div>
        <div className="pr-guar">
          <div>
            <span className="pr-gt"><span className="pr-tag ok">EXACT</span>Commands that arrive whole</span>
            <span className="pr-chips"><span className="pr-chip">SSH command</span><span className="pr-chip">kubectl exec</span><span className="pr-chip">Redis</span><span className="pr-chip">MongoDB</span></span>
            <span className="pr-gd">Captivo sees the full command and matches it exactly against the list.</span>
          </div>
          <div>
            <span className="pr-gt"><span className="pr-tag warn">GUARDRAIL</span>Interactive shells</span>
            <span className="pr-gd">Captivo sees the line the user types. The shell then expands aliases, history, completion and scripts, so a list catches what is typed but is not a wall.</span>
            <span className="pr-gd strong">Also give the account only the rights it needs on the server.</span>
          </div>
        </div>
        {lists.length === 0 ? (
          <div className="pr-empty">
            <b>No command lists yet</b><span>Create a list, then attach it to a profile or straight to a resource.</span>
            <button type="button" className="btn" onClick={() => setList("new")}>+ New list</button>
          </div>
        ) : lists.map((l) => {
          const users = profiles.filter((p) => p.commandListId === l.id);
          return (
            <div key={l.id} className="pr-row top">
              <div className="pr-lmain">
                <span className="pr-lh"><span className={`pr-tag big ${l.mode === "allow" ? "ok" : "bad"}`}>{l.mode === "allow" ? "ALLOW" : "BLOCK"}</span><b>{l.name}</b></span>
                <span className="pr-sum">{listSummary(l)}{l.description ? ` · ${l.description}` : ""}</span>
                <span className="pr-cmds">
                  {l.entries.slice(0, 12).map((e) => <code key={e} className={`pr-cmd ${l.mode === "allow" ? "ok" : "bad"}`}>{e}</code>)}
                  {l.entries.length > 12 && <span className="pr-more">+{l.entries.length - 12}</span>}
                </span>
              </div>
              <div className="pr-used">
                <span className="pr-lbl">USED BY</span>
                <span className="pr-pills">
                  {users.map((p) => <span key={p.id} className="pr-pill">{p.name}</span>)}
                  <span className="pr-use">
                    {users.length === 0 && l.direct === 0 ? "Not in use"
                      : l.direct === 0 ? ""
                      : users.length === 0 ? `${n(l.direct, "resource", "resources")} directly`
                      : `+ ${n(l.direct, "resource", "resources")} directly`}
                  </span>
                </span>
              </div>
              <div className="pr-acts">
                <button type="button" className="btn sm pr-edit" onClick={() => setList(l)}>Edit</button>
                <button type="button" className="btn sm pr-del" aria-label={`Delete ${l.name}`} onClick={() => { setProblem(null); setAsk({ kind: "command-lists", id: l.id }); }}>Delete</button>
              </div>
              {ask?.kind === "command-lists" && ask.id === l.id && confirmBar("command-lists", l.id, l.name,
                l.profiles + l.resources > 0
                  ? `${[l.profiles ? n(l.profiles, "profile uses", "profiles use") : "", l.resources ? n(l.resources, "resource uses", "resources use") : ""].filter(Boolean).join(" and ")} it. Move ${l.profiles + l.resources === 1 ? "it" : "them"} to another list first.`
                  : null)}
            </div>
          );
        })}
      </section>

      {profile && <ProfileDialog key={profile === "new" ? "new" : profile.id} profile={profile === "new" ? null : profile} lists={lists} onClose={() => setProfile(null)} onSaved={(m) => { setProfile(null); setToast(m); router.refresh(); }} />}
      {list && <ListDialog key={list === "new" ? "new" : list.id} list={list === "new" ? null : list} onClose={() => setList(null)} onSaved={(m) => { setList(null); setToast(m); router.refresh(); }} />}
      {toast && <div className="pr-toast" role="status"><i aria-hidden="true" />{toast}</div>}
    </div>
  );
}

function ListDialog({ list, onClose, onSaved }: { list: ListRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [mode, setMode] = useState<"allow" | "deny">(list?.mode ?? "deny");
  const [entries, setEntries] = useState((list?.entries ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = entries.split(/\r?\n/).map((e) => e.trim()).filter(Boolean).length;
  const ready = name.trim().length > 0 && count > 0;
  const status = error ?? (!touched || ready ? "Applies to new sessions." : !name.trim() ? "Give it a name to save." : "Add at least one command.");

  async function save() {
    if (!ready) { setTouched(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(list ? `/api/admin/policy/command-lists/${list.id}` : "/api/admin/policy/command-lists", {
        method: list ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: description.trim() || null, mode, entries }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errText(r?.error)); return; }
      onSaved(list ? "Saved" : "Created");
    } catch { setError("Couldn't save. Try again."); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={list ? "Edit command list" : "New command list"} subtitle="Attach it to a profile or straight to a resource." size="md">
      <form className="rq" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="rq-sec"><span className="rq-label"><span>Name</span><span className="mono t-muted">{name.length}/48</span></span>
          <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. Destructive commands" autoFocus /></label>
        <div className="rq-sec">
          <span className="rq-label"><span>Type</span></span>
          <div className="pr-opts" role="radiogroup" aria-label="Type">
            {([["deny", "BLOCK", "Block list", "Everything runs except the commands on the list.", "bad"], ["allow", "ALLOW", "Allow list", "Only the commands on the list run.", "ok"]] as const).map(([v, tag, t, d, tone]) => (
              <button key={v} type="button" role="radio" aria-checked={mode === v} className={`pr-opt${mode === v ? " on" : ""}`} onClick={() => setMode(v)}>
                <span className="pr-opt-t"><i className="pr-ring" aria-hidden="true" /><span className={`pr-tag ${tone}`}>{tag}</span>{t}</span>
                <span className="pr-opt-d">{d}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="rq-sec"><span className="rq-label"><span>Commands</span><span className="mono t-muted">{count === 0 ? "none yet" : n(count, "command", "commands")}</span></span>
          <textarea className="textarea mono" rows={6} value={entries} onChange={(e) => setEntries(e.target.value)} spellCheck={false}
            placeholder={mode === "allow" ? "ls\nuptime\nsystemctl status *\ncat /var/log/*" : "rm\nmkfs\nshutdown\nsystemctl stop *"} />
          <span className="rq-hint">One command per line.</span></label>
        <p className="rq-hint">A plain word names a command whatever its arguments (<span className="mono">rm</span>). Anything with a space or a <span className="mono">*</span> is matched against the whole command (<span className="mono">systemctl stop *</span>). Names are not case sensitive. In a block list, every word of a line is looked at, so <span className="mono">sudo rm</span> and <span className="mono">sh -c &apos;rm …&apos;</span> are caught too.</p>
        <label className="rq-sec"><span className="rq-label"><span>Note <span className="t-muted">(optional)</span></span></span>
          <input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="rq-foot">
          <span className={`rq-status${error ? " pr-bad" : ""}`} role={error ? "alert" : "status"}>{status}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" aria-disabled={!ready || busy} disabled={busy} style={!ready ? { opacity: 0.5 } : undefined}>{busy ? "Saving…" : list ? "Save changes" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ProfileDialog({ profile, lists, onClose, onSaved }: { profile: ProfileRow | null; lists: ListRow[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [record, setRecord] = useState(profile?.recordSessions ?? true);
  const [keys, setKeys] = useState(profile?.keystrokeLogging ?? false);
  const [clip, setClip] = useState(profile?.clipboardMode ?? "allow");
  const [wm, setWm] = useState(profile?.watermark == null ? "" : profile.watermark ? "on" : "off");
  const [ft, setFt] = useState(profile?.fileTransferMode ?? "");
  const [egress, setEgress] = useState(profile?.egressMode ?? "");
  const [hosts, setHosts] = useState((profile?.egressHosts ?? []).join("\n"));
  const [moderated, setModerated] = useState(profile?.requireModerator ?? false);
  const [checkout, setCheckout] = useState(profile?.passwordCheckout ?? false);
  const [minutes, setMinutes] = useState(String(profile?.checkoutMaxMinutes ?? 240));
  const [listId, setListId] = useState(profile?.commandListId ?? "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0;
  const status = error ?? (!touched || ready ? (profile && profile.resources > 0 ? `Changes reach ${n(profile.resources, "resource", "resources")}; open sessions keep theirs.` : "Applies to new sessions.") : "Give it a name to save.");

  async function save() {
    if (!ready) { setTouched(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(profile ? `/api/admin/policy/profiles/${profile.id}` : "/api/admin/policy/profiles", {
        method: profile ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, description: description.trim() || null, recordSessions: record, keystrokeLogging: keys, clipboardMode: clip || null,
          watermark: wm === "" ? null : wm === "on", fileTransferMode: ft || null, egressMode: egress || null,
          egressHosts: egress === "strict" ? hosts.split(/\r?\n/).map((h) => h.trim()).filter(Boolean) : [],
          requireModerator: moderated, passwordCheckout: checkout && !moderated, checkoutMaxMinutes: Number(minutes), commandListId: listId || null,
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errText(r?.error)); return; }
      onSaved(profile ? "Saved" : "Created");
    } catch { setError("Couldn't save. Try again."); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={profile ? "Edit profile" : "New profile"} subtitle="Settings every following resource takes." size="lg">
      <form className="rq" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="rq-sec"><span className="rq-label"><span>Name</span><span className="mono t-muted">{name.length}/48</span></span>
          <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vendor servers" autoFocus /></label>
        <label className="rq-sec"><span className="rq-label"><span>Note <span className="t-muted">(optional)</span></span></span>
          <input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>

        <div className="pr-group">
          <Field title="Record sessions" desc="Keep a recording of every session on these resources."><Switch on={record} onChange={setRecord} label="Record sessions" /></Field>
          <Field title="Log keystrokes" desc="Store what is typed alongside the recording (needs recording)."><Switch on={keys} onChange={setKeys} label="Log keystrokes" /></Field>
          <Field title="Clipboard" desc="Copy and paste between the user’s device and the session."><Seg value={clip} onChange={setClip} options={CLIP} label="Clipboard" /></Field>
          <Field title="Watermark"><Seg value={wm} onChange={setWm} options={WM} label="Watermark" /></Field>
          <Field title="File transfer" desc="Isolated browsers and web apps."><Seg value={ft} onChange={setFt} options={FT} label="File transfer" /></Field>
          <Field title="Network access" desc="Isolated browsers."><Seg value={egress} onChange={setEgress} options={EGRESS} label="Network access" /></Field>
          {egress === "strict" && (
            <label className="rq-sec pr-pad"><span className="rq-label"><span>Also allow these hosts</span><span className="mono t-muted">one per line</span></span>
              <textarea className="textarea mono" rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="sso.example.com&#10;*.okta.com" spellCheck={false} /></label>
          )}
          <Field title="Needs a moderator" desc="Remote desktop and SSH. Four eyes: a session starts only when a moderator admits it."><Switch on={moderated} onChange={setModerated} label="Needs a moderator" /></Field>
          <Field title="Password check-out" desc={moderated ? "Off while a moderator is needed: the password stays." : "Remote desktop, SSH and databases. The grant decides who may see it."}><Switch on={checkout && !moderated} onChange={setCheckout} label="Password check-out" /></Field>
          {checkout && !moderated && <Field title="Longest check-out"><Seg value={minutes} onChange={setMinutes} options={LENGTHS} label="Longest check-out" /></Field>}
        </div>

        <div className="rq-sec">
          <span className="rq-label"><span>Command list</span></span>
          <div className="pr-radios" role="radiogroup" aria-label="Command list">
            <button type="button" role="radio" aria-checked={listId === ""} className={`pr-opt row${listId === "" ? " on" : ""}`} onClick={() => setListId("")}>
              <span className="pr-opt-t"><i className="pr-ring" aria-hidden="true" />No list</span><span className="pr-opt-d">Every command runs.</span>
            </button>
            {lists.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={listId === l.id} className={`pr-opt row${listId === l.id ? " on" : ""}`} onClick={() => setListId(l.id)}>
                <span className="pr-opt-t"><i className="pr-ring" aria-hidden="true" />{l.name}<span className={`pr-tag ${l.mode === "allow" ? "ok" : "bad"}`}>{l.mode === "allow" ? "ALLOW" : "BLOCK"}</span></span>
                <span className="pr-opt-d mono">{l.entries.slice(0, 5).join(" · ")}{l.entries.length > 5 ? ` · +${l.entries.length - 5}` : ""}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rq-foot">
          <span className={`rq-status${error ? " pr-bad" : ""}`} role={error ? "alert" : "status"}>{status}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" aria-disabled={!ready || busy} disabled={busy} style={!ready ? { opacity: 0.5 } : undefined}>{busy ? "Saving…" : profile ? "Save changes" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
