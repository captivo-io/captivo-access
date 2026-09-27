import { sep } from "node:path";
import { describe, it, expect } from "vitest";
import { isClientComponent, referencesWrapper, routeIsTenantScoped, bareMethodExports, listFiles, readSrc } from "./entry-point-scope";

describe("entry-point-scope helpers", () => {
  it("detects a client component", () => {
    expect(isClientComponent(`"use client";\nexport default function X(){}`)).toBe(true);
    expect(isClientComponent(`// a comment\n"use client"\n`)).toBe(true);
    expect(isClientComponent(`export default function X(){}`)).toBe(false);
  });
  it("finds a referenced wrapper", () => {
    expect(referencesWrapper(`import { withRequestTenant } from "@/lib/tenant/request";`, "withRequestTenant")).toBe(true);
    expect(referencesWrapper(`const x = 1;`, "withRequestTenant")).toBe(false);
  });
  it("accepts the deferred wrapper only when the route scopes its own phases", () => {
    // The deferred wrapper opens no scope; inTenant is what applies the tenant.
    // Accepting it alone would let a route resolve a tenant and then query outside
    // any scope -- the exact hole this invariant exists to close.
    const both = `import { inTenant, withDeferredTenantRoute } from "@/lib/tenant/request";
export const POST = withDeferredTenantRoute(async (tenantId, req) => inTenant(tenantId, async () => new Response()));`;
    const wrapperOnly = `import { withDeferredTenantRoute } from "@/lib/tenant/request";
export const POST = withDeferredTenantRoute(async (tenantId, req) => new Response());`;
    expect(routeIsTenantScoped(both)).toBe(true);
    expect(routeIsTenantScoped(wrapperOnly)).toBe(false);
    expect(routeIsTenantScoped(`export const POST = withTenantRoute(async () => {});`)).toBe(true);
    expect(routeIsTenantScoped(`export async function POST(){}`)).toBe(false);
  });
  it("flags bare method exports, ignores wrapped ones", () => {
    expect(bareMethodExports(`export async function POST(req){}`)).toEqual(["POST"]);
    expect(bareMethodExports(`export function GET(){}\nexport async function DELETE(){}`)).toEqual(["GET", "DELETE"]);
    expect(bareMethodExports(`export const POST = withTenantRoute(async (req) => {});`)).toEqual([]);
  });
});

const norm = (p: string) => p.split(sep).join("/");
const isRsc = (p: string) => /(?:page|layout)\.tsx$/.test(p);

// Exempt: tenant-agnostic shell, or a token/bootstrap page that must render
// before any tenant is known (so it must NOT 404 on an unresolved host). Each
// reasoned; a tenant-scoped page under any tree that is neither wrapped nor
// listed here fails the test below.
const RSC_EXEMPT: Array<[string, string]> = [
  ["src/app/layout.tsx", "root shell; fonts + theme bootstrap only, no tenant DB work"],
  ["src/app/setup/page.tsx", "first-run bootstrap; hasAnyUser() count only, reads no currentTenantId()-keyed config"],
];

describe("RSC entry points are tenant-scoped", () => {
  it("every server page/layout under src/app wraps withRequestTenant or is allow-listed", () => {
    const offenders: string[] = [];
    for (const file of listFiles("src/app", isRsc)) {
      const f = norm(file);
      if (RSC_EXEMPT.some(([p]) => f === p || f.startsWith(p))) continue;
      const src = readSrc(file);
      if (isClientComponent(src)) continue;
      if (!referencesWrapper(src, "withRequestTenant")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

const isRoute = (p: string) => /route\.ts$/.test(p);

// Exempt: resolve tenant by a non-host mechanism, or tenant-agnostic. Reason each.
const EXEMPT_PREFIXES: Array<[string, string]> = [
  ["src/app/api/internal/", "dataplane calls; tenant from dataplane identifier (withTenantFrom)"],
  ["src/app/api/platform/", "platform tenant; PLATFORM_TENANT_ID scope"],
  ["src/app/api/cron/", "no request host; fans out per tenant via forEachTenant"],
  ["src/app/api/auth/registration/", "invite/recovery/setup enrollment; scope from its own token (invite/recover/setup) flow"],
  ["src/app/api/auth/logout/", "session-token based; destroys the session by token hash under RLS; reads no currentTenantId()-keyed config"],
  ["src/app/api/auth/recover/", "pre-session recovery; user resolved by email+TOTP under RLS; reads no currentTenantId()-keyed config"],
  ["src/app/api/connector/enroll/", "tunnel host + pairing token; resolved via SECURITY DEFINER"],
  ["src/app/api/recovery/", "pre-session recovery; resolved by token/email"],
  ["src/app/api/health/", "tenant-agnostic liveness"],
];
describe("all /api tenant route handlers are scoped or explicitly exempt", () => {
  it("every route.ts is wrapped or allow-listed with a reason", () => {
    const unwrapped: string[] = [];
    for (const file of listFiles("src/app/api", isRoute)) {
      const f = norm(file);
      if (EXEMPT_PREFIXES.some(([p]) => f.startsWith(p))) continue;
      const src = readSrc(file);
      const bare = bareMethodExports(src);
      if (bare.length || !routeIsTenantScoped(src)) unwrapped.push(`${f} [${bare.join(",")}]`);
    }
    expect(unwrapped).toEqual([]);
  });
});
