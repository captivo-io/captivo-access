"use client";
import { useRouter } from "next/navigation";
import { ResourceForm, type ResourceContext, type ResourceInitial, type VaultMeta, type EgressEvent } from "../../resource-form";

export function EditResource({ ctx, site, vault, egressEvents }: { ctx: ResourceContext; site: ResourceInitial; vault?: VaultMeta; egressEvents?: EgressEvent[] }) {
  const router = useRouter();
  return (
    <div className="rf-page">
      <ResourceForm ctx={ctx} site={site} vault={vault} egressEvents={egressEvents}
        onClose={() => router.push("/admin/sites")} onSaved={() => router.push("/admin/sites")} />
    </div>
  );
}
