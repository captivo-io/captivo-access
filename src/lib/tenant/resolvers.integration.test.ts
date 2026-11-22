// Proves the SECURITY DEFINER resolvers used from non-request contexts
// (data-plane internal API, connector enrollment, cron): each resolve_tenant_by_*
// maps a real key to its tenant id and an unknown/foreign key to NULL;
// list_active_tenant_ids() enumerates ACTIVE tenants excluding the reserved
// 'platform' tenant; the two candidate-list functions surface rows across
// tenants for the app-side bcrypt scans. Requires a live Postgres via
// TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql applied);
// SKIPPED otherwise. Runs as the table owner (RLS-bypass already, same as the
// platform.integration.test.ts pattern), so it exercises the functions directly
// without needing the app role or MULTI_TENANT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!HAS_DB);

let owner: PrismaClient;

const suffix = crypto.randomUUID().slice(0, 8);
const tenantA = { id: `rvt-a-${suffix}`, slug: `rvt-a-${suffix}` };
const tenantB = { id: `rvt-b-${suffix}`, slug: `rvt-b-${suffix}` };

const userA = `rvu-a-${suffix}`;
const userB = `rvu-b-${suffix}`;
const connectorA = `rvc-a-${suffix}`;
const connectorB = `rvc-b-${suffix}`;
const siteA = `rvs-a-${suffix}`;
const siteB = `rvs-b-${suffix}`;
const sessionA = `rvsess-a-${suffix}`;
const sessionB = `rvsess-b-${suffix}`;
const sessionTokenHashA = `rv-tok-a-${suffix}`;
const sessionTokenHashB = `rv-tok-b-${suffix}`;
const recordingA = `rvrec-a-${suffix}`;
const recordingB = `rvrec-b-${suffix}`;
const recordingKeyA = `rv-key-a-${suffix}`;
const recordingKeyB = `rv-key-b-${suffix}`;
const pairingA = `rvpair-a-${suffix}`;
const pairingB = `rvpair-b-${suffix}`;
const dbTicketA = `rvdbt-a-${suffix}`;
const dbTicketHashA = `rv-dbt-hash-a-${suffix}`;

beforeAll(async () => {
  if (!HAS_DB) return;
  owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });

  await owner.$executeRawUnsafe(
    `INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Resolver Test A','ACTIVE'),($3,$4,'Resolver Test B','ACTIVE')`,
    tenantA.id, tenantA.slug, tenantB.id, tenantB.slug,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "User"(id,"tenantId",email,name,role,status,"createdAt") VALUES
       ($1,$2,'a@rvt.test','User A','ADMIN','ACTIVE',now()),
       ($3,$4,'b@rvt.test','User B','ADMIN','ACTIVE',now())`,
    userA, tenantA.id, userB, tenantB.id,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,"createdAt") VALUES
       ($1,$2,'Connector A','${sessionTokenHashA}-conn','ONLINE',now()),
       ($3,$4,'Connector B','${sessionTokenHashB}-conn','ONLINE',now())`,
    connectorA, tenantA.id, connectorB, tenantB.id,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","createdAt") VALUES
       ($1,$2,$3,'Site A','TRANSPARENT',now()),
       ($4,$5,$6,'Site B','TRANSPARENT',now())`,
    siteA, tenantA.id, connectorA, siteB, tenantB.id, connectorB,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "Session"(id,"tenantId","userId","tokenHash","expiresAt","createdAt","lastSeenAt") VALUES
       ($1,$2,$3,$4, now() + interval '1 day', now(), now()),
       ($5,$6,$7,$8, now() + interval '1 day', now(), now())`,
    sessionA, tenantA.id, userA, sessionTokenHashA,
    sessionB, tenantB.id, userB, sessionTokenHashB,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "SessionRecording"(id,"tenantId","recordingKey","siteId","userId",host,"startedAt","lastEventAt") VALUES
       ($1,$2,$3,$4,$5,'host-a.rvt.test',now(),now()),
       ($6,$7,$8,$9,$10,'host-b.rvt.test',now(),now())`,
    recordingA, tenantA.id, recordingKeyA, siteA, userA,
    recordingB, tenantB.id, recordingKeyB, siteB, userB,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "ConnectorPairing"(id,"tenantId","codeHash",name,"connectorId","expiresAt","createdAt") VALUES
       ($1,$2,'rv-pair-hash-a','Pairing A',$3, now() + interval '1 hour', now()),
       ($4,$5,'rv-pair-hash-b','Pairing B',$6, now() + interval '1 hour', now())`,
    pairingA, tenantA.id, connectorA, pairingB, tenantB.id, connectorB,
  );

  await owner.$executeRawUnsafe(
    `INSERT INTO "DbTicket"(id,"tenantId","codeHash","userId","siteId","sessionId","expiresAt","createdAt") VALUES
       ($1,$2,$3,$4,$5,$6, now() + interval '1 hour', now())`,
    dbTicketA, tenantA.id, dbTicketHashA, userA, siteA, sessionA,
  );
});

afterAll(async () => {
  if (!HAS_DB) return;
  await owner.$executeRawUnsafe(`DELETE FROM "DbTicket" WHERE id = $1`, dbTicketA);
  await owner.$executeRawUnsafe(`DELETE FROM "ConnectorPairing" WHERE id IN ($1,$2)`, pairingA, pairingB);
  await owner.$executeRawUnsafe(`DELETE FROM "SessionRecording" WHERE id IN ($1,$2)`, recordingA, recordingB);
  await owner.$executeRawUnsafe(`DELETE FROM "Session" WHERE id IN ($1,$2)`, sessionA, sessionB);
  await owner.$executeRawUnsafe(`DELETE FROM "Site" WHERE id IN ($1,$2)`, siteA, siteB);
  await owner.$executeRawUnsafe(`DELETE FROM "Connector" WHERE id IN ($1,$2)`, connectorA, connectorB);
  await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ($1,$2)`, userA, userB);
  await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id IN ($1,$2)`, tenantA.id, tenantB.id);
  await owner.$disconnect();
});

d("SECURITY DEFINER resolvers for non-request contexts", () => {
  it("resolve_tenant_by_user: real id -> tenant, unknown id -> null", async () => {
    const a = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_user($1) AS id`, userA);
    expect(a[0].id).toBe(tenantA.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_user($1) AS id`, "nope-user");
    expect(missing[0].id).toBeNull();
  });

  it("resolve_tenant_by_site: real id -> tenant, unknown id -> null", async () => {
    const b = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_site($1) AS id`, siteB);
    expect(b[0].id).toBe(tenantB.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_site($1) AS id`, "nope-site");
    expect(missing[0].id).toBeNull();
  });

  it("resolve_tenant_by_session_token: real hash -> tenant, foreign/unknown hash -> null", async () => {
    const a = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_session_token($1) AS id`, sessionTokenHashA,
    );
    expect(a[0].id).toBe(tenantA.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_session_token($1) AS id`, "nope-token",
    );
    expect(missing[0].id).toBeNull();
  });

  it("resolve_tenant_by_recording_key: real key -> tenant, unknown key -> null", async () => {
    const b = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_recording_key($1) AS id`, recordingKeyB,
    );
    expect(b[0].id).toBe(tenantB.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_recording_key($1) AS id`, "nope-key",
    );
    expect(missing[0].id).toBeNull();
  });

  it("resolve_tenant_by_connector: real id -> tenant, unknown id -> null", async () => {
    const a = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_connector($1) AS id`, connectorA,
    );
    expect(a[0].id).toBe(tenantA.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(
      `SELECT resolve_tenant_by_connector($1) AS id`, "nope-connector",
    );
    expect(missing[0].id).toBeNull();
  });

  it("resolve_tenant_by_db_ticket: real hash -> tenant, unknown hash -> null", async () => {
    const a = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_db_ticket($1) AS id`, dbTicketHashA);
    expect(a[0].id).toBe(tenantA.id);
    const missing = await owner.$queryRawUnsafe<{ id: string | null }[]>(`SELECT resolve_tenant_by_db_ticket($1) AS id`, "nope-hash");
    expect(missing[0].id).toBeNull();
  });

  it("list_active_tenant_ids: includes seeded tenants, excludes the platform + default sentinels", async () => {
    const rows = await owner.$queryRawUnsafe<{ id: string }[]>(`SELECT list_active_tenant_ids() AS id`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(tenantA.id);
    expect(ids).toContain(tenantB.id);
    // The reserved 'default' (self-host sentinel) and 'platform' tenants are not
    // real customer tenants and must not appear in the cron fan-out list.
    expect(ids).not.toContain("default");
    expect(ids).not.toContain("platform");
  });

  it("list_connector_token_candidates: returns rows across both tenants", async () => {
    const rows = await owner.$queryRawUnsafe<{ id: string; tenantId: string; tokenHash: string }[]>(
      `SELECT * FROM list_connector_token_candidates()`,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(connectorA)?.tenantId).toBe(tenantA.id);
    expect(byId.get(connectorB)?.tenantId).toBe(tenantB.id);
  });

  it("list_pairing_candidates: returns rows across both tenants", async () => {
    const rows = await owner.$queryRawUnsafe<
      { id: string; tenantId: string; codeHash: string; expiresAt: Date; usedAt: Date | null }[]
    >(`SELECT * FROM list_pairing_candidates()`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pairingA)?.tenantId).toBe(tenantA.id);
    expect(byId.get(pairingB)?.tenantId).toBe(tenantB.id);
    expect(byId.get(pairingA)?.usedAt).toBeNull();
  });
});
