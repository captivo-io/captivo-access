"use client";
import Link from "next/link";
import type { SiteRow } from "./sites-view";

// Edit opens the full-page site editor (which also surfaces the Vault credential
// section for GATEWAY sites) rather than a modal. connectors/recordingEnabled are
// accepted for call-site compatibility but the full page loads its own data.
export function EditSiteButton({
  site,
}: {
  site: SiteRow;
  connectors: { id: string; name: string; vaultPublicKey?: string | null }[];
  recordingEnabled: boolean;
}) {
  return (
    <Link className="btn sm" href={`/admin/sites/${site.id}/edit`}>
      Edit
    </Link>
  );
}
