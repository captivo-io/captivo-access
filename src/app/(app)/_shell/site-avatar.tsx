import { siteAvatar } from "@/lib/site/avatar";
import { ResourceIcon } from "@/components/resource-icon";
import type { IconColor } from "@/lib/site/icons";

// Badge for a Site: the uploaded logo when one exists, otherwise a deterministic
// initial-letter avatar. Hookless, so it works in both server and client trees.
// Decorative — the Site name beside it is the accessible label.
export function SiteAvatar({ name, siteId, hasLogo, icon, logoBg, size = 36 }: {
  name: string; siteId?: string; hasLogo?: boolean;
  /** The resource's resolved tile (lib/site/icons resolveIcon); initials are only the fallback without it. */
  icon?: { name: string; color: IconColor }; logoBg?: string | null; size?: number;
}) {
  if (icon) {
    return <ResourceIcon name={icon.name} color={icon.color} logoUrl={hasLogo && siteId ? `/api/sites/${encodeURIComponent(siteId)}/logo` : null} logoBg={logoBg} size={size} />;
  }
  if (hasLogo && siteId) {
    return (
      <img
        className="site-avatar site-avatar-img"
        src={`/api/sites/${encodeURIComponent(siteId)}/logo`}
        alt=""
        aria-hidden="true"
      />
    );
  }
  const { initials, bg, fg } = siteAvatar(name);
  return (
    <span className="site-avatar" aria-hidden="true" style={{ background: bg, color: fg }}>
      {initials}
    </span>
  );
}
