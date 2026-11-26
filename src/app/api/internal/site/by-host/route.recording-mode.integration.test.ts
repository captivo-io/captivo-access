// Proves the tenant recordingMode policy is actually enforced where the
// data-plane resolves "should this site record" — the by-host route — under a
// real Postgres (RLS-enforced, app role), and that it round-trips through the
// policy API with cross-tenant isolation. Requires a live Postgres via
// TEST_DATABASE_URL (owner connection, schema pushed, pre-push.sql +
// bootstrap.sql applied, `app` role present); SKIPPED otherwise. Mirrors
// audit/log's dataplane harness (real exported POST, x-dataplane-secret,
// app-role APP_DATABASE_URL) for the by-host calls, and smtp's policy-route
// harness (mocked next/headers + current-user, withTenantRoute) for the API
// round-trip.
//
// MUST run in its own vitest process (mutates process-wide env + the db
// module cache) — CI runs it as a separate `vitest run`.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_PW = "rls_test_pw";

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = APP_PW;
  return u.toString();
}

const suffix = crypto.randomUUID().slice(0, 8);
const tenantA = { id: `rm-a-${suffix}`, slug: `rm-a-${suffix}` };
const tenantB = { id: `rm-b-${suffix}`, slug: `rm-b-${suffix}` };
const connectorA = `rm-conn-a-${suffix}`;
const connectorB = `rm-conn-b-${suffix}`;
// TRANSPARENT sites under tenant A: one with the resource toggle off, one on —
// enforcement must not just reflect the toggle, and "off" must suppress even
// the toggle-on site.
const siteMain = `rm-site-main-${suffix}`;
const siteToggleOn = `rm-site-on-${suffix}`;
const siteB = `rm-site-b-${suffix}`;
const hostMain = `rm-main-${suffix}.example.test`;
const hostToggleOn = `rm-on-${suffix}.example.test`;
const hostB = `rm-b-${suffix}.example.test`;
const DP_SECRET = `rm-dp-secret-${suffix}`;
const adminUser = { id: `rm-admin-${suffix}`, email: "admin@a.test", role: "ADMIN" as const };

// Mock the request host that resolveRequestTenant (policy API) reads via
// next/headers(); the by-host route resolves its tenant from the POST body
// instead, so this only matters for the policy-route calls below.
let mockHost = "";
vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-host", mockHost]]) as unknown as Headers,
}));

// Auth is not what this test is about — stand in a fixed admin with "configure".
vi.mock("@/lib/current-user", () => ({
  getCurrentUser: async () => adminUser,
}));

function byHostReq(host: string): NextRequest {
  return new Request("http://internal/api/internal/site/by-host", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET },
    body: JSON.stringify({ host }),
  }) as unknown as NextRequest;
}

function policyReq(body: Record<string, unknown>): NextRequest {
  return new Request("http://tenant/api/admin/policy/platform", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe.skipIf(!OWNER_URL)("recordingMode is enforced at by-host and round-trips through the policy API", () => {
  let owner: PrismaClient;
  let byHostPOST: (req: NextRequest) => Promise<Response>;
  let policyPOST: (req: NextRequest) => Promise<Response>;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let resolvedRecordingMode: () => Promise<string>;
  let savePlatformSettings: typeof import("@/lib/settings/platform").savePlatformSettings;

  // A full PlatformSettings input with every field null except recordingMode —
  // mirrors src/lib/settings/recording-mode.integration.test.ts's settingsWith.
  // Routed through the real savePlatformSettings() (not a raw upsert) so the
  // module's per-tenant settings cache is invalidated exactly as it is in
  // production use, instead of leaving byHostPOST reading a stale cache entry.
  function settingsWith(recordingMode: string | null) {
    return {
      auditRetentionDays: null,
      inviteTtlHours: null,
      notificationWebhookUrl: null,
      vendorIpAllowlist: null,
      maxGrantDays: null,
      recordingConsentRequired: null,
      watermarkDefault: null,
      clipboardDefault: null,
      displayTimezone: null,
      recordingRetentionDays: null,
      defaultConnectorLogLevel: null,
      externalAnchorEnabled: null,
      anchorTsaUrl: null,
      anchorTsaAuth: null,
      notifySiteHealth: null,
      notifyAccessRequests: null,
      notifyAccessDecisions: null,
      requireRequestJustification: null,
      keystrokeLoggingMode: null,
      isolatedEgressDefault: null,
      isolatedFileTransferDefault: null,
      webAppFileTransferDefault: null,
      sessionInvitesEnabled: null,
      guestRequireSecondFactor: null,
      moderatorRoles: null,
      revealRequiresReason: null,
      checkoutRequiresReason: null,
      recordingMode,
    };
  }

  async function setRecordingMode(tenantId: string, mode: string | null) {
    await withTenant(tenantId, () => savePlatformSettings(settingsWith(mode)));
  }

  async function recordSessionsFor(host: string): Promise<boolean> {
    const res = await byHostPOST(byHostReq(host));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recordSessions: boolean };
    return json.recordSessions;
  }

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });

    await owner.$executeRawUnsafe(
      `INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Recording Mode Enforcement A','ACTIVE'),($3,$4,'Recording Mode Enforcement B','ACTIVE')`,
      tenantA.id, tenantA.slug, tenantB.id, tenantB.slug,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,"createdAt") VALUES ($1,$2,'Connector A','${suffix}-conn-a','ONLINE',now())`,
      connectorA, tenantA.id,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,"createdAt") VALUES ($1,$2,'Connector B','${suffix}-conn-b','ONLINE',now())`,
      connectorB, tenantB.id,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode",hostname,"recordSessions","createdAt") VALUES ($1,$2,$3,'Site Main','TRANSPARENT',$4,false,now())`,
      siteMain, tenantA.id, connectorA, hostMain,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode",hostname,"recordSessions","createdAt") VALUES ($1,$2,$3,'Site Toggle On','TRANSPARENT',$4,true,now())`,
      siteToggleOn, tenantA.id, connectorA, hostToggleOn,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode",hostname,"recordSessions","createdAt") VALUES ($1,$2,$3,'Site B','TRANSPARENT',$4,true,now())`,
      siteB, tenantB.id, connectorB, hostB,
    );

    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.ACCESS_DOMAIN = "example.test";
    process.env.MANAGER_PUBLIC_URL = "https://manager.example.test";
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ POST: byHostPOST } = await import("@/app/api/internal/site/by-host/route"));
    ({ POST: policyPOST } = await import("@/app/api/admin/policy/platform/route"));
    ({ withTenant } = await import("@/lib/tenant/scope"));
    ({ resolvedRecordingMode, savePlatformSettings } = await import("@/lib/settings/platform"));
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformSettings" WHERE "tenantId" IN ($1,$2)`, tenantA.id, tenantB.id);
    await owner.$executeRawUnsafe(`DELETE FROM "Site" WHERE id IN ($1,$2,$3)`, siteMain, siteToggleOn, siteB);
    await owner.$executeRawUnsafe(`DELETE FROM "Connector" WHERE id IN ($1,$2)`, connectorA, connectorB);
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id IN ($1,$2)`, tenantA.id, tenantB.id);
    await owner.$disconnect();
    delete process.env.MULTI_TENANT;
    delete process.env.APP_DATABASE_URL;
    delete process.env.DATAPLANE_SECRET;
    delete process.env.ACCESS_DOMAIN;
    delete process.env.MANAGER_PUBLIC_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.RECORDING_ENABLED;
  });

  it("required forces record on despite the site's own toggle being false", async () => {
    process.env.RECORDING_ENABLED = "on";
    await setRecordingMode(tenantA.id, "required");
    expect(await recordSessionsFor(hostMain)).toBe(true);
  });

  it("off suppresses record even when a second site's toggle is true", async () => {
    process.env.RECORDING_ENABLED = "on";
    await setRecordingMode(tenantA.id, "off");
    expect(await recordSessionsFor(hostMain)).toBe(false);
    expect(await recordSessionsFor(hostToggleOn)).toBe(false);
  });

  it("per_resource matches the site's own toggle", async () => {
    process.env.RECORDING_ENABLED = "on";
    await setRecordingMode(tenantA.id, "per_resource");
    expect(await recordSessionsFor(hostMain)).toBe(false);
    expect(await recordSessionsFor(hostToggleOn)).toBe(true);
  });

  it("RECORDING_ENABLED off forces record off for every mode", async () => {
    process.env.RECORDING_ENABLED = "off";
    for (const mode of ["off", "per_resource", "required"]) {
      await setRecordingMode(tenantA.id, mode);
      expect(await recordSessionsFor(hostToggleOn)).toBe(false);
    }
  });

  it("round-trips recordingMode through the policy API and stays isolated per tenant", async () => {
    process.env.RECORDING_ENABLED = "on";
    await setRecordingMode(tenantA.id, "per_resource"); // reset from the prior test

    mockHost = `${tenantA.slug}.example.test`;
    const res = await policyPOST(policyReq({ recordingMode: "required" }));
    expect(res.status).toBe(200);

    const modeA = await withTenant(tenantA.id, () => resolvedRecordingMode());
    expect(modeA).toBe("required");

    // Tenant B was never touched — its policy stays the reproduced default.
    const modeB = await withTenant(tenantB.id, () => resolvedRecordingMode());
    expect(modeB).toBe("per_resource");
  });

  it("web app file transfer: an inheriting site follows the Policy default, which starts at allow", async () => {
    async function fileTransferFor(host: string): Promise<string> {
      const res = await byHostPOST(byHostReq(host));
      expect(res.status).toBe(200);
      return ((await res.json()) as { fileTransferMode: string }).fileTransferMode;
    }
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "fileTransferMode" = NULL WHERE id = $1`, siteMain);
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "fileTransferMode" = 'no_upload' WHERE id = $1`, siteToggleOn);
    await setRecordingMode(tenantA.id, "per_resource"); // also clears the web app default
    expect(await fileTransferFor(hostMain)).toBe("allow");

    mockHost = `${tenantA.slug}.example.test`;
    const res = await policyPOST(policyReq({ webAppFileTransferDefault: "no_download" }));
    expect(res.status).toBe(200);
    expect(await fileTransferFor(hostMain)).toBe("no_download");
    // A site's own choice wins over the Policy default.
    expect(await fileTransferFor(hostToggleOn)).toBe("no_upload");
  });
});
