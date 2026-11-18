import { ICON_PATHS, type IconColor } from "@/lib/site/icons";

// The tile for a resource (design hand-off 10, 7.19): a library icon on a tint
// of its colour, or the uploaded logo on a white / tinted / clear ground.
// Hookless, so it renders in server and client trees alike.
export function ResourceIcon({ name, color, logoUrl, logoBg = "white", size = 42, className }: {
  name: string;
  color: IconColor;
  /** A URL (never a data: URL in a style string); the logo wins over the icon. */
  logoUrl?: string | null;
  logoBg?: string | null;
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.26) };
  if (logoUrl) {
    return (
      <span className={["ri", `ri-${color}`, "ri-logo", `ri-bg-${logoBg ?? "white"}`, className].filter(Boolean).join(" ")} style={box} aria-hidden="true">
        <span className="ri-img" style={{ backgroundImage: `url("${logoUrl.replace(/"/g, "%22")}")`, padding: Math.round(size * 0.14) }} />
      </span>
    );
  }
  return (
    <span className={["ri", `ri-${color}`, className].filter(Boolean).join(" ")} style={box} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.48)} height={Math.round(size * 0.48)} fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? ICON_PATHS.globe }} />
    </span>
  );
}
