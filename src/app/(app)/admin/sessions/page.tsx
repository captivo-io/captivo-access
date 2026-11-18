import { redirect } from "next/navigation";
import { withRequestTenant } from "@/lib/tenant/request";

// Console sign-ins are a tab of the People page now.
export default async function SessionsRedirect() {
  return withRequestTenant(async () => redirect("/admin/users?tab=sessions"));
}
