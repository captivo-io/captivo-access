"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";

type Site = { id: string; name: string };

const ERR: Record<string, string> = {
  invalid_name: "Give the review a name (up to 80 characters).",
  unknown_resource: "One of the resources no longer exists. Reload and try again.",
};

function defaultName(now: Date): string {
  return `Access review · Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

/** "New review": scope, due date, repetition and what silence means. */
export function NewReviewButton({ sites }: { sites: Site[]; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>+ New review</button>
      {open && <NewReviewDialog sites={sites} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewReviewDialog({ sites, onClose }: { sites: Site[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(() => defaultName(new Date()));
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dueDays, setDueDays] = useState(14);
  const [recurrence, setRecurrence] = useState("");
  const [onNoAnswer, setOnNoAnswer] = useState<"revoke" | "keep">("revoke");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0 && (all || picked.size > 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/reviews", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), siteIds: all ? [] : [...picked], dueDays, recurrence: recurrence || null, onNoAnswer }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.id) { setError(ERR[j.error] ?? "Couldn't start the review. Try again."); return; }
      router.push(`/admin/reviews/${j.id}`);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Modal open onClose={onClose} title="New access review" subtitle="It lists every live grant now, with when it was last used." size="md">
      <form className="arv-form" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
        <label className="rq-sec"><span className="rq-label"><span>Name</span></span>
          <input id="arv-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>

        <div className="rq-sec">
          <span className="rq-label"><span>Resources</span></span>
          <div className="seg" role="radiogroup" aria-label="Resources">
            <button type="button" role="radio" aria-checked={all} className={all ? "seg-opt on" : "seg-opt"} onClick={() => setAll(true)}>All resources</button>
            <button type="button" role="radio" aria-checked={!all} className={!all ? "seg-opt on" : "seg-opt"} onClick={() => setAll(false)}>Choose</button>
          </div>
          {!all && (
            <div className="arv-sites">
              {sites.map((s) => (
                <label key={s.id} className="arv-site"><input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} /> {s.name}</label>
              ))}
            </div>
          )}
        </div>

        <div className="arv-row">
          <label className="rq-sec"><span className="rq-label"><span>Reviewers have</span></span>
            <select id="arv-due" className="select" value={dueDays} onChange={(e) => setDueDays(Number(e.target.value))}>
              <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
            </select></label>
          <label className="rq-sec"><span className="rq-label"><span>Repeat</span></span>
            <select id="arv-rec" className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="">Only this time</option><option value="quarterly">Every 3 months</option><option value="semiannual">Every 6 months</option><option value="yearly">Every year</option>
            </select></label>
        </div>

        <div className="rq-sec">
          <span className="rq-label"><span>Grants nobody decides on by the due date</span></span>
          <div className="seg" role="radiogroup" aria-label="Unanswered grants">
            <button type="button" role="radio" aria-checked={onNoAnswer === "revoke"} className={onNoAnswer === "revoke" ? "seg-opt on" : "seg-opt"} onClick={() => setOnNoAnswer("revoke")}>Remove them</button>
            <button type="button" role="radio" aria-checked={onNoAnswer === "keep"} className={onNoAnswer === "keep" ? "seg-opt on" : "seg-opt"} onClick={() => setOnNoAnswer("keep")}>Keep, and flag in the report</button>
          </div>
          <p className="rf-hint">{onNoAnswer === "revoke" ? "Access nobody confirms ends when the review closes. Two kinds are only flagged: grants from a directory group (they are listed for removal from the group) and the reviewers' own." : "Nothing changes for unanswered grants; the report lists them as not reviewed."}</p>
        </div>

        <p className="rf-hint">Admins and operators review, and get an email when it opens, a week before and a day before it is due. Nobody decides on their own access.</p>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="arv-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>{busy ? "Starting…" : "Start review"}</button>
        </div>
      </form>
    </Modal>
  );
}
