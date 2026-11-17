import type { Role } from "@/generated/prisma/enums";
import type { SearchRecord } from "@/lib/search";
import type { NavModel } from "@/lib/nav/model";
import type { ProductMenuItem } from "@/lib/products/product-menu";
import type { ShellWorkspace } from "@/lib/nav/shell-data";
import { PlatformAnnouncement } from "@/components/platform-announcement";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { Sidebar, type ShellView } from "./sidebar";
import { AppHeader } from "./app-header";

/**
 * The one app shell of the design hand-off, for the console and for a person's
 * own access alike: sidebar, sticky header, and the page. `banners` sit above
 * the page (support access, a pending update).
 */
export function Shell(props: {
  model: NavModel;
  view: ShellView;
  records: SearchRecord[];
  role: Role;
  products: ProductMenuItem[];
  workspace: ShellWorkspace;
  user: { name: string; email: string };
  accountUrl: string | null;
  banners?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <Sidebar
        model={props.model}
        view={props.view}
        roleLabel={ROLE_LABELS[props.role] ?? props.role}
        products={props.products}
        workspace={props.workspace}
        user={props.user}
        accountUrl={props.accountUrl}
      />
      <div className="shell-main">
        <AppHeader model={props.model} records={props.records} role={props.role} workspace={props.workspace.name} />
        <PlatformAnnouncement />
        {props.banners}
        <main className="content">{props.children}</main>
      </div>
    </div>
  );
}
