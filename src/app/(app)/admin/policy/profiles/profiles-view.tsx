"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { useConfirm } from "@/app/(app)/_shell/confirm-dialog";
import { describeCommandList, MAX_COMMAND_LISTS } from "@/lib/policy/command-lists";

export type ListRow = { id: string; name: string; description: string | null; mode: "allow" | "deny"; entries: string[]; resources: number; profiles: number };
export type ProfileRow = {
  id: string; name: string; description: string | null; recordSessions: boolean; keystrokeLogging: boolean; clipboardMode: string | null; watermark: boolean | null;
  fileTransferMode: string | null; egressMode: string | null; egressHosts: string[]; requireModerator: boolean; passwordCheckout: boolean; checkoutMaxMinutes: number;
  commandListId: string | null; resources: number;
};

const CLIP: [string, string][] = [["", "Policy"], ["allow", "Copy & paste"], ["no_paste", "Copy only"], ["no_copy", "Paste only"], ["none", "Block"]];
const FT: [string, string][] = [["", "Policy"], ["allow", "Upload & download"], ["no_download", "Upload only"], ["no_upload", "Download only"], ["none", "Block"]];
const EGRESS: [string, string][] = [["", "Policy"], ["internet", "The resource and the internet"], ["strict", "Only listed hosts"], ["open", "Unrestricted"]];
const WM: [string, string][] = [["", "Policy"], ["on", "On"], ["off", "Off"]];
const LENGTHS: [string, string][] = [["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["240", "4 hours"], ["480", "8 hours"], ["1440", "24 hours"]];

const ERRORS: Record<string, string> = {
  invalid_name: "Give it a name.", name_too_long: "The name can be at most 48 characters.", name_taken: "Another one already has that name.",
  invalid_mode: "Pick allow or block.", invalid_entries: "Enter one command per line.", too_many_entries: "At most 200 entries.", entry_too_long: "An entry can be at most 200 characters.",
  entry_has_control: "An entry can't contain control characters.", too_many_lists: `At most ${MAX_COMMAND_LISTS} command lists.`, too_many_profiles: "At most 50 profiles.",
  invalid_egress_hosts: "Allowed hosts must be host names (sso.example.com, *.okta.com) or IP addresses.", invalid_checkout_minutes: "Pick one of the check-out lengths.",
  unknown_command_list: "That command list no longer exists.", forbidden: "Admin privileges are required.",
};
const errText = (code?: string) => (code && ERRORS[code]) || "Couldn't save. Try again.";

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? "toggle on" : "toggle"} onClick={() => onChange(!on)}><span /></button>;
}
function Seg({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <div className="seg pf-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "seg-opt on" : "seg-opt"} onClick={() => onChange(v)}>{t}</button>)}
    </div>
  );
}
function Field({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return <div className="pf-field"><div className="pf-field-t"><b>{title}</b>{desc && <span className="cell-sub">{desc}</span>}</div><div className="pf-field-c">{children}</div></div>;
}

export function ProfilesView({ workspace, profiles, lists }: { workspace: string | null; profiles: ProfileRow[]; lists: ListRow[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [profile, setProfile] = useState<ProfileRow | "new" | null>(null);
  const [list, setList] = useState<ListRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listName = (id: string | null) => lists.find((l) => l.id === id)?.name ?? null;

  async function remove(kind: "profiles" | "command-lists", id: string, name: string) {
    if (!(await confirm(`Delete "${name}"?`, { danger: true, confirmLabel: "Delete" }))) return;
    const res = await fetch(`/api/admin/policy/${kind}/${id}`, { method: "DELETE" });
    const r = await res.json().catch(() => ({}));
    if (res.ok) { setNotice(`"${name}" deleted`); router.refresh(); return; }
    setNotice(r?.error === "in_use" ? `"${name}" is still used by ${[r.resources ? `${r.resources} resource${r.resources === 1 ? "" : "s"}` : "", r.profiles ? `${r.profiles} profile${r.profiles === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}. Move them to another one first.` : errText(r?.error));
  }

  return (
    <>
      <div className="pol-head">
        <div className="eyebrow">Infrastructure{workspace ? ` · ${workspace}` : ""}</div>
        <h1>Profiles & lists</h1>
        <p>Name a set of session settings once and give it to any number of resources. Add allow or block lists of commands for the resources that need them.</p>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="pol-card" id="profiles" aria-labelledby="profiles-t">
        <div className="pol-card-h">
          <span><b id="profiles-t">Policy profiles</b><span className="cell-sub">A resource that follows a profile takes its settings. Change the profile and every resource that follows it changes with it (sessions already open keep theirs).</span></span>
          <button type="button" className="btn primary" onClick={() => setProfile("new")}>New profile</button>
        </div>
        {profiles.length === 0 ? <p className="pf-empty">No profiles yet. Resources follow the Policy page and their own settings.</p> : (
          <ul className="pf-rows">
            {profiles.map((p) => (
              <li key={p.id} className="pf-row">
                <div className="pf-row-main">
                  <b>{p.name}</b>
                  {p.description && <span className="cell-sub">{p.description}</span>}
                  <span className="pf-chips">
                    {p.recordSessions && <span className="pol-chip">RECORDED</span>}
                    {p.keystrokeLogging && <span className="pol-chip">KEYSTROKES</span>}
                    {p.requireModerator && <span className="pol-chip">MODERATED</span>}
                    {p.passwordCheckout && <span className="pol-chip">PASSWORD CHECK-OUT</span>}
                    {p.clipboardMode && <span className="pol-chip">CLIPBOARD: {p.clipboardMode.replace("_", " ").toUpperCase()}</span>}
                    {listName(p.commandListId) && <span className="pol-chip p">COMMANDS: {listName(p.commandListId)}</span>}
                  </span>
                </div>
                <span className="mono t-muted">{p.resources} {p.resources === 1 ? "resource" : "resources"}</span>
                <div className="row-actions">
                  <button type="button" className="btn sm" onClick={() => setProfile(p)}>Edit</button>
                  <button type="button" className="btn sm" onClick={() => void remove("profiles", p.id, p.name)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pol-card" id="lists" aria-labelledby="lists-t">
        <div className="pol-card-h">
          <span><b id="lists-t">Command lists</b><span className="cell-sub">An allow list lets only what it names run. A block list lets everything run except what it names. Up to {MAX_COMMAND_LISTS} lists.</span></span>
          <button type="button" className="btn primary" disabled={lists.length >= MAX_COMMAND_LISTS} onClick={() => setList("new")}>New list</button>
        </div>
        <p className="pf-warn" role="note">
          <b>What a list guarantees.</b> Where a command arrives whole (an SSH command, <span className="mono">kubectl exec</span>, a Redis or MongoDB command) it is matched exactly. In a shell the user types into, Captivo sees the typed line, and the shell then expands aliases, history, completion and scripts: there a list is a guardrail that catches what is typed, not a wall. Give the account only the rights it needs on the server as well.
        </p>
        {lists.length === 0 ? <p className="pf-empty">No command lists yet.</p> : (
          <ul className="pf-rows">
            {lists.map((l) => (
              <li key={l.id} className="pf-row">
                <div className="pf-row-main">
                  <b>{l.name}</b>
                  <span className="cell-sub">{describeCommandList(l)}{l.description ? ` · ${l.description}` : ""}</span>
                  <span className="pf-chips">{l.entries.slice(0, 6).map((e) => <span key={e} className="pol-chip mono">{e}</span>)}{l.entries.length > 6 && <span className="pol-chip">+{l.entries.length - 6}</span>}</span>
                </div>
                <span className="mono t-muted">{l.resources} {l.resources === 1 ? "resource" : "resources"}{l.profiles ? ` · ${l.profiles} ${l.profiles === 1 ? "profile" : "profiles"}` : ""}</span>
                <div className="row-actions">
                  <button type="button" className="btn sm" onClick={() => setList(l)}>Edit</button>
                  <button type="button" className="btn sm" onClick={() => void remove("command-lists", l.id, l.name)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile && <ProfileDialog key={profile === "new" ? "new" : profile.id} profile={profile === "new" ? null : profile} lists={lists} onClose={() => setProfile(null)} onSaved={(m) => { setProfile(null); setNotice(m); router.refresh(); }} />}
      {list && <ListDialog key={list === "new" ? "new" : list.id} list={list === "new" ? null : list} onClose={() => setList(null)} onSaved={(m) => { setList(null); setNotice(m); router.refresh(); }} />}
      {dialog}
    </>
  );
}

function ListDialog({ list, onClose, onSaved }: { list: ListRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [mode, setMode] = useState<"allow" | "deny">(list?.mode ?? "deny");
  const [entries, setEntries] = useState((list?.entries ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(list ? `/api/admin/policy/command-lists/${list.id}` : "/api/admin/policy/command-lists", {
        method: list ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: description.trim() || null, mode, entries }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errText(r?.error)); return; }
      onSaved(list ? "Command list saved" : "Command list created");
    } catch { setError("Couldn't save. Try again."); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={list ? "Edit command list" : "New command list"} size="md">
      <form className="rq" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="rq-sec"><span className="rq-label"><span>Name</span><span className="mono t-muted">{name.length}/48</span></span>
          <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. Read-only operations" autoFocus /></label>
        <div className="rq-sec">
          <span className="rq-label"><span>What the list does</span></span>
          <Seg value={mode} onChange={(v) => setMode(v as "allow" | "deny")} label="Mode" options={[["deny", "Block these"], ["allow", "Allow only these"]]} />
          <p className="rq-hint">{mode === "allow" ? "Only the commands below may run; everything else is refused. An empty allow list refuses every command." : "Everything may run, whatever the account's own rights allow, except the commands below."}</p>
        </div>
        <label className="rq-sec"><span className="rq-label"><span>Commands</span><span className="mono t-muted">one per line</span></span>
          <textarea className="textarea mono" rows={9} value={entries} onChange={(e) => setEntries(e.target.value)} spellCheck={false}
            placeholder={mode === "allow" ? "ls\nuptime\nsystemctl status *\ncat /var/log/*" : "rm\nmkfs\nshutdown\nsystemctl stop *"} /></label>
        <p className="rq-hint">A plain word names a command whatever its arguments (<span className="mono">rm</span>). Anything with a space or a <span className="mono">*</span> is matched against the whole command (<span className="mono">systemctl stop *</span>). Names are not case sensitive. In a block list, every word of a line is looked at, so <span className="mono">sudo rm</span> and <span className="mono">sh -c &apos;rm …&apos;</span> are caught too.</p>
        <label className="rq-sec"><span className="rq-label"><span>Note <span className="t-muted">(optional)</span></span></span>
          <input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="rq-foot"><span className="rq-status" /><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}

function ProfileDialog({ profile, lists, onClose, onSaved }: { profile: ProfileRow | null; lists: ListRow[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [record, setRecord] = useState(profile?.recordSessions ?? false);
  const [keys, setKeys] = useState(profile?.keystrokeLogging ?? false);
  const [clip, setClip] = useState(profile?.clipboardMode ?? "");
  const [wm, setWm] = useState(profile?.watermark == null ? "" : profile.watermark ? "on" : "off");
  const [ft, setFt] = useState(profile?.fileTransferMode ?? "");
  const [egress, setEgress] = useState(profile?.egressMode ?? "");
  const [hosts, setHosts] = useState((profile?.egressHosts ?? []).join("\n"));
  const [moderated, setModerated] = useState(profile?.requireModerator ?? false);
  const [checkout, setCheckout] = useState(profile?.passwordCheckout ?? false);
  const [minutes, setMinutes] = useState(String(profile?.checkoutMaxMinutes ?? 240));
  const [listId, setListId] = useState(profile?.commandListId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
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
      onSaved(profile ? `Profile saved${r?.resources ? `; ${r.resources} ${r.resources === 1 ? "resource" : "resources"} updated` : ""}` : "Profile created");
    } catch { setError("Couldn't save. Try again."); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={profile ? "Edit policy profile" : "New policy profile"} size="lg">
      <form className="rq" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="rq-sec"><span className="rq-label"><span>Name</span><span className="mono t-muted">{name.length}/48</span></span>
          <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vendor, recorded" autoFocus /></label>
        <label className="rq-sec"><span className="rq-label"><span>Note <span className="t-muted">(optional)</span></span></span>
          <input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>
        <p className="rq-hint">Each setting applies to the kinds of resource that have it: a remote desktop or SSH resource takes recording, keystrokes, clipboard, moderator and check-out; an isolated browser takes the network rule; databases and Kubernetes take recording and check-out. “Policy” follows the Policy page.</p>

        <Field title="Record sessions" desc="Required for the keystroke timeline."><Switch on={record} onChange={setRecord} label="Record sessions" /></Field>
        <Field title="Keystroke logging" desc="Typed commands on a timeline next to the recording."><Switch on={keys} onChange={setKeys} label="Keystroke logging" /></Field>
        <Field title="Clipboard"><Seg value={clip} onChange={setClip} options={CLIP} label="Clipboard" /></Field>
        <Field title="Watermark"><Seg value={wm} onChange={setWm} options={WM} label="Watermark" /></Field>
        <Field title="File transfer" desc="Isolated browsers and web apps."><Seg value={ft} onChange={setFt} options={FT} label="File transfer" /></Field>
        <Field title="Network access" desc="Isolated browsers."><Seg value={egress} onChange={setEgress} options={EGRESS} label="Network access" /></Field>
        {egress === "strict" && (
          <label className="rq-sec"><span className="rq-label"><span>Also allow these hosts</span><span className="mono t-muted">one per line</span></span>
            <textarea className="textarea mono" rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="sso.example.com&#10;*.okta.com" spellCheck={false} /></label>
        )}
        <Field title="Needs a moderator" desc="Remote desktop and SSH. Four eyes: a session starts only when a moderator admits it."><Switch on={moderated} onChange={setModerated} label="Needs a moderator" /></Field>
        <Field title="Password check-out" desc={moderated ? "Off while a moderator is needed: the password stays." : "Remote desktop, SSH and databases. The grant decides who may see it."}><Switch on={checkout && !moderated} onChange={setCheckout} label="Password check-out" /></Field>
        {checkout && !moderated && (
          <Field title="Longest check-out"><Seg value={minutes} onChange={setMinutes} options={LENGTHS} label="Longest check-out" /></Field>
        )}
        <Field title="Command list" desc="SSH, Kubernetes and databases.">
          <select className="input" value={listId} onChange={(e) => setListId(e.target.value)} aria-label="Command list">
            <option value="">None</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.mode === "allow" ? "allow only" : "block"}</option>)}
          </select>
        </Field>

        {profile && profile.resources > 0 && <p className="rq-hint">{profile.resources} {profile.resources === 1 ? "resource follows" : "resources follow"} this profile and will take these settings when you save.</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="rq-foot"><span className="rq-status" /><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}
