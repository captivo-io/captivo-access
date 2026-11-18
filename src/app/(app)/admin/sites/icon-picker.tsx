"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ResourceIcon } from "@/components/resource-icon";
import { ICON_COLORS, ICON_LABELS, ICON_NAMES, type IconColor } from "@/lib/site/icons";

const COLOR_LABEL: Record<IconColor, string> = { blue: "Blue", violet: "Violet", green: "Green", amber: "Amber", cyan: "Cyan", slate: "Slate" };
const BG_LABEL: Record<string, string> = { white: "White", tint: "Colour", none: "Clear" };
const LOGO_TYPES = ["image/png", "image/svg+xml", "image/jpeg", "image/webp"];
export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * What the tile is set to. `iconName: null` = automatic (from the name).
 * logo: "keep" the stored one, null to remove it, or a new file (data URL for
 * the upload, an object URL for the preview).
 */
export interface Look {
  iconName: string | null;
  iconColor: IconColor;
  logoBg: string;
  logo: "keep" | null | { dataUrl: string; type: string; previewUrl: string };
}

export function lookBody(look: Look, initial: Look) {
  const body: Record<string, unknown> = {};
  if (look.iconName !== initial.iconName) body.iconName = look.iconName;
  if (look.iconColor !== initial.iconColor) body.iconColor = look.iconColor;
  if (look.logoBg !== initial.logoBg) body.logoBg = look.logoBg;
  if (look.logo === null) body.logo = null;
  else if (look.logo !== "keep") { body.logo = look.logo.dataUrl; body.logoType = look.logo.type; }
  return body;
}

/** The tile as it will look: preview sizes 56 / 42 / 28 with the name and "PROTO · icon". */
export function TilePreview({ look, autoName, storedLogoUrl, name, proto }: { look: Look; autoName: string; storedLogoUrl: string | null; name: string; proto: string }) {
  const icon = look.iconName ?? autoName;
  const logoUrl = look.logo === "keep" ? storedLogoUrl : look.logo === null ? null : look.logo.previewUrl;
  return (
    <div className="ip-preview">
      {[56, 42, 28].map((s) => <ResourceIcon key={s} name={icon} color={look.iconColor} logoUrl={logoUrl} logoBg={look.logoBg} size={s} />)}
      <span className="ip-preview-t"><b>{name || "New resource"}</b><span className="mono t-muted">{proto} · {logoUrl ? "Your logo" : ICON_LABELS[icon]}</span></span>
    </div>
  );
}

export function IconPicker({ look, onChange, autoName, storedLogoUrl, name, proto }: {
  look: Look; onChange: (l: Look) => void; autoName: string; storedLogoUrl: string | null; name: string; proto: string;
}) {
  const hasLogo = look.logo !== null && (look.logo !== "keep" || !!storedLogoUrl);
  const [tab, setTab] = useState<"library" | "logo">(hasLogo ? "logo" : "library");
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const objectUrl = look.logo !== null && look.logo !== "keep" ? look.logo.previewUrl : null;
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);
  const icon = look.iconName ?? autoName;

  function take(f: File | undefined) {
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type)) { setErr("Use a PNG, SVG, JPG or WebP file."); return; }
    if (f.size > MAX_LOGO_BYTES) { setErr("The logo must be 512 KB or smaller."); return; }
    setErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      onChange({ ...look, logo: { dataUrl: reader.result, type: f.type, previewUrl: URL.createObjectURL(f) } });
    };
    reader.readAsDataURL(f);
  }
  const autoChip = useMemo(() => look.iconName === null && !hasLogo, [look.iconName, hasLogo]);

  return (
    <div className="ip">
      <div className="rq-label">
        <span>Icon</span>
        {autoChip ? <span className="ip-auto"><span aria-hidden="true">●</span> Automatic · {ICON_LABELS[autoName]}</span>
          : look.iconName !== null && !hasLogo ? <button type="button" className="link-button ip-reset" onClick={() => onChange({ ...look, iconName: null })}>Back to automatic</button> : null}
      </div>
      <TilePreview look={look} autoName={autoName} storedLogoUrl={storedLogoUrl} name={name} proto={proto} />
      <div className="seg ip-tabs" role="tablist" aria-label="Icon source">
        <button type="button" role="tab" aria-selected={tab === "library"} className={tab === "library" ? "seg-opt on" : "seg-opt"} onClick={() => setTab("library")}>Icon library</button>
        <button type="button" role="tab" aria-selected={tab === "logo"} className={tab === "logo" ? "seg-opt on" : "seg-opt"} onClick={() => setTab("logo")}>Your logo</button>
      </div>
      {tab === "library" ? (
        <>
          <div className="ip-grid" role="radiogroup" aria-label="Icon">
            {ICON_NAMES.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={!hasLogo && icon === n} title={ICON_LABELS[n]} aria-label={ICON_LABELS[n]}
                className={["ip-cell", !hasLogo && icon === n && `on ri-${look.iconColor}`].filter(Boolean).join(" ")}
                onClick={() => onChange({ ...look, iconName: n, logo: hasLogo ? null : look.logo })}>
                <ResourceIcon name={n} color={!hasLogo && icon === n ? look.iconColor : "slate"} size={30} className="ip-glyph" />
                {n === autoName && <span className="ip-sugg" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="ip-colors">
            <span className="cell-sub">{hasLogo ? "Colour" : ICON_LABELS[icon]}</span>
            <span className="ip-sugg-key"><span className="ip-sugg" aria-hidden="true" /> suggested from the name</span>
            <div className="ip-swatches" role="radiogroup" aria-label="Colour">
              {ICON_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={look.iconColor === c} aria-label={COLOR_LABEL[c]} title={COLOR_LABEL[c]}
                  className={look.iconColor === c ? `ip-sw ri-${c} on` : `ip-sw ri-${c}`} onClick={() => onChange({ ...look, iconColor: c })} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="ip-logo">
          <div className={drag ? "ip-drop on" : "ip-drop"} role="button" tabIndex={0}
            onClick={() => file.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") file.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); }}>
            <b>Drop a logo here, or choose a file</b>
            <span className="cell-sub">PNG, SVG, JPG or WebP · up to 512 KB · square, 128 px or more works best</span>
            <input ref={file} type="file" accept={LOGO_TYPES.join(",")} hidden onChange={(e) => take(e.target.files?.[0])} />
          </div>
          {err && <p className="ip-err" role="alert">{err}</p>}
          {hasLogo && (
            <div className="ip-bgs">
              <span className="cell-sub">Background</span>
              <div className="seg" role="radiogroup" aria-label="Logo background">
                {(["white", "tint", "none"] as const).map((b) => (
                  <button key={b} type="button" role="radio" aria-checked={look.logoBg === b} className={look.logoBg === b ? "seg-opt on" : "seg-opt"} onClick={() => onChange({ ...look, logoBg: b })}>{BG_LABEL[b]}</button>
                ))}
              </div>
              <button type="button" className="btn sm" onClick={() => { onChange({ ...look, logo: null }); setTab("library"); }}>Remove logo</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
