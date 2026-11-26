// Pins resolvedRecordingMode()'s DB → env → default resolution under a real
// tenant scope (RLS-enforced, app role). Requires a live Postgres via
// TEST_DATABASE_URL (owner connection, schema pushed, prisma/rls/bootstrap.sql
// applied — that already enables RLS + tenant_isolation on PlatformSettings, so
// this file only needs to seed a Tenant row and use withTenant); SKIPPED
// otherwise. Mirrors the harness of src/app/api/admin/smtp/route.scope.integration.test.ts
// (app role bootstrap via psql beforehand, MULTI_TENANT + APP_DATABASE_URL env,
// withTenant for a real tenant-scoped transaction) and
// src/lib/tenant/platform.integration.test.ts (owner client + seeded Tenant row).
// Seeds via the real savePlatformSettings() (not a raw upsert) so the module's
// settings cache is invalidated exactly as it is in production use.
//
// MUST run in its own vitest process (mutates process-wide env + the db module
// cache) — CI runs it as a separate `vitest run`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;

const suffix = crypto.randomUUID().slice(0, 8);
const tenantId = `rec-mode-${suffix}`;

// A full PlatformSettings input with every field null except the one under test.
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

describe.skipIf(!OWNER_URL)("resolvedRecordingMode under a real tenant scope", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let resolvedRecordingMode: () => Promise<string>;
  let savePlatformSettings: (input: ReturnType<typeof settingsWith>) => Promise<void>;

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    await owner.$executeRawUnsafe(
      `INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Recording Mode IT','ACTIVE') ON CONFLICT (id) DO NOTHING`,
      tenantId, tenantId,
    );

    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = OWNER_URL!;
    delete (globalThis as { prismaBase?: unknown }).prismaBase;

    ({ withTenant } = await import("@/lib/tenant/scope"));
    ({ resolvedRecordingMode, savePlatformSettings } = await import("@/lib/settings/platform"));
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformSettings" WHERE "tenantId" = $1`, tenantId);
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tenantId);
    await owner.$disconnect();
    delete process.env.MULTI_TENANT;
    delete process.env.APP_DATABASE_URL;
  });

  it("unset → per_resource (the reproduced default)", async () => {
    const mode = await withTenant(tenantId, () => resolvedRecordingMode());
    expect(mode).toBe("per_resource");
  });

  it("stored 'required' → required", async () => {
    await withTenant(tenantId, () => savePlatformSettings(settingsWith("required")));
    const mode = await withTenant(tenantId, () => resolvedRecordingMode());
    expect(mode).toBe("required");
  });

  it("an invalid stored value falls back to per_resource", async () => {
    await withTenant(tenantId, () => savePlatformSettings(settingsWith("bogus")));
    const mode = await withTenant(tenantId, () => resolvedRecordingMode());
    expect(mode).toBe("per_resource");
  });
});
