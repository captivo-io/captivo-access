-- Phase 0b-2: install the tenant-isolation RLS layer. Runs AFTER `db push`
-- (tables exist), idempotent. DORMANT on self-host: the app connects as the
-- table owner, which bypasses RLS; the `app` role + GUC are used only once
-- multi-tenant is activated (Phase 2). We never FORCE ROW LEVEL SECURITY (that
-- would trap the owner too). `app_password` is passed via `psql -v`.

-- 1. Non-owner application role (only when a password is supplied and it is absent).
SELECT (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app')) AND :'app_password' <> '' AS need_role \gset
\if :need_role
CREATE ROLE app LOGIN PASSWORD :'app_password';
\endif

-- 2. Grants (only if the role exists).
SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') AS have_role \gset
\if :have_role
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
\endif

-- 3. Enable RLS + the tenant_isolation policy on every table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','Passkey','TotpSecret','Invite','Session','Connector','ConnectorPairing',
    'Site','VaultCredential','AccessGrant','AuditEvent','AuditChainState','AuditAnchor',
    'AdminAuditAnchor','SmtpConfig','BrandingConfig','Notification','OidcConfig',
    'DirectoryConfig','GroupMapping','SessionPolicy','CronRun','PlatformSettings',
    'UpdateCheckConfig','SessionRecording','RecordingChunk','SessionKeyEvent','AdminAuditEvent',
    'SupportHandoff'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.current_tenant'', true)) WITH CHECK ("tenantId" = current_setting(''app.current_tenant'', true))',
      t);
  END LOOP;

  -- Tenant is keyed by id (a tenant sees only its own row).
  EXECUTE 'ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "Tenant"';
  EXECUTE 'CREATE POLICY tenant_isolation ON "Tenant" USING ("id" = current_setting(''app.current_tenant'', true)) WITH CHECK ("id" = current_setting(''app.current_tenant'', true))';
END $$;

-- 4. Write-side stamping. Prisma's @default("default") sends tenantId="default"
-- explicitly on INSERT, bypassing any column default. This BEFORE INSERT trigger
-- replaces that sentinel with the request's tenant GUC (deterministic,
-- connection-bound — no dependency on app-level ALS). Self-host: GUC unset ⇒
-- no-op, tenantId stays "default". An explicit non-default tenantId is left
-- alone and validated by the RLS WITH CHECK.
CREATE OR REPLACE FUNCTION set_tenant_from_guc() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.current_tenant', true) IS NOT NULL
     AND current_setting('app.current_tenant', true) <> ''
     AND NEW."tenantId" = 'default' THEN
    NEW."tenantId" := current_setting('app.current_tenant', true);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','Passkey','TotpSecret','Invite','Session','Connector','ConnectorPairing',
    'Site','VaultCredential','AccessGrant','AuditEvent','AuditChainState','AuditAnchor',
    'AdminAuditAnchor','SmtpConfig','BrandingConfig','Notification','OidcConfig',
    'DirectoryConfig','GroupMapping','SessionPolicy','CronRun','PlatformSettings',
    'UpdateCheckConfig','SessionRecording','RecordingChunk','SessionKeyEvent','AdminAuditEvent',
    'SupportHandoff'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_tenant_from_guc ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_tenant_from_guc BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_tenant_from_guc()', t);
  END LOOP;
END $$;

-- 5. SECURITY DEFINER resolvers (Phase 2b). Owner-defined so they bypass RLS —
-- the app role has no tenant scope yet when resolving a request's tenant from
-- its host. Read-only, STABLE, search_path pinned; EXECUTE granted only to app.
CREATE OR REPLACE FUNCTION resolve_tenant_by_slug(p_slug text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM "Tenant" WHERE slug = p_slug AND status = 'ACTIVE' AND "deletedAt" IS NULL
$$;
CREATE OR REPLACE FUNCTION resolve_tenant_by_hostname(p_host text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "Site" WHERE hostname = p_host LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_tenant_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_hostname(text) FROM PUBLIC;

SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') AS have_role \gset
\if :have_role
GRANT EXECUTE ON FUNCTION resolve_tenant_by_slug(text) TO app;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_hostname(text) TO app;
\endif

-- 6. Platform control-plane functions (cross-tenant, RLS-bypass). Owner-defined
-- so a platform admin — whose session is RLS-scoped to the reserved 'platform'
-- tenant — can manage OTHER tenants. Authorization is app-level
-- (requirePlatformAdmin); these do the RLS-bypass mechanics only.
-- p_captivo_org is the Captivo ID organisation a self-service workspace was
-- provisioned for (NULL for tenants an operator creates by hand). It is written
-- in the same statement as the row so a second workspace for the same
-- organisation cannot slip between a check and an update: the unique index on
-- "Tenant"."captivoOrgId" is what actually decides.
-- The 3-argument version is dropped rather than replaced -- adding a parameter
-- changes the signature, and leaving both in place would make every 3-argument
-- call ambiguous.
DROP FUNCTION IF EXISTS platform_create_tenant(text, text, text);
CREATE OR REPLACE FUNCTION platform_create_tenant(p_id text, p_slug text, p_name text, p_captivo_org text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "Tenant"(id, slug, name, status, "captivoOrgId")
  VALUES (p_id, p_slug, p_name, 'ACTIVE', p_captivo_org);
  RETURN p_id;
END $$;

-- The slug of the workspace already provisioned for a Captivo ID organisation,
-- or NULL. Soft-deleted tenants are INCLUDED on purpose: the unique index still
-- holds their organisation id, so hiding them here would only turn a clear
-- refusal into a unique-violation the caller cannot explain.
CREATE OR REPLACE FUNCTION platform_tenant_slug_by_org(p_org text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT slug FROM "Tenant" WHERE "captivoOrgId" = p_org $$;

DROP FUNCTION IF EXISTS platform_list_tenants();
CREATE OR REPLACE FUNCTION platform_list_tenants()
RETURNS TABLE(id text, slug text, name text, status text, "createdAt" timestamptz, "adminCount" bigint,
              plan text, "trialEndsAt" timestamptz, "deletedAt" timestamptz, limits jsonb, capabilities jsonb, notes text, "updatedAt" timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT t.id, t.slug, t.name, t.status, t."createdAt",
         (SELECT count(*) FROM "User" u WHERE u."tenantId" = t.id AND u.role = 'ADMIN') AS "adminCount",
         t.plan, t."trialEndsAt", t."deletedAt", t.limits, t.capabilities, t.notes, t."updatedAt"
  FROM "Tenant" t
  WHERE t.id NOT IN ('platform', 'default')
  ORDER BY t."createdAt" DESC
$$;

CREATE OR REPLACE FUNCTION platform_set_tenant_status(p_id text, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'invalid tenant status: %', p_status;
  END IF;
  IF p_id = 'platform' THEN
    RAISE EXCEPTION 'cannot change the platform tenant status';
  END IF;
  UPDATE "Tenant" SET status = p_status WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION platform_create_tenant(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_tenant_slug_by_org(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_list_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_set_tenant_status(text, text) FROM PUBLIC;

SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') AS have_role \gset
\if :have_role
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text) TO app;
GRANT EXECUTE ON FUNCTION platform_tenant_slug_by_org(text) TO app;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO app;
GRANT EXECUTE ON FUNCTION platform_set_tenant_status(text, text) TO app;
\endif

-- 7. Additional resolvers for non-request contexts (data-plane internal API,
-- connector enrollment, cron). Owner-defined RLS-bypass, like section 5.
CREATE OR REPLACE FUNCTION resolve_tenant_by_user(p_id text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "User" WHERE id = p_id $$;
CREATE OR REPLACE FUNCTION resolve_tenant_by_site(p_id text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "Site" WHERE id = p_id $$;
CREATE OR REPLACE FUNCTION resolve_tenant_by_session_token(p_hash text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "Session" WHERE "tokenHash" = p_hash $$;
CREATE OR REPLACE FUNCTION resolve_tenant_by_recording_key(p_key text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "SessionRecording" WHERE "recordingKey" = p_key $$;
CREATE OR REPLACE FUNCTION resolve_tenant_by_connector(p_id text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT "tenantId" FROM "Connector" WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION list_active_tenant_ids()
RETURNS SETOF text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM "Tenant" WHERE status = 'ACTIVE' AND "deletedAt" IS NULL AND id NOT IN ('platform', 'default') $$;

CREATE OR REPLACE FUNCTION list_connector_token_candidates()
RETURNS TABLE(id text, "tenantId" text, "tokenHash" text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id, "tenantId", "tokenHash" FROM "Connector" $$;
CREATE OR REPLACE FUNCTION list_pairing_candidates()
RETURNS TABLE(id text, "tenantId" text, "codeHash" text, "expiresAt" timestamptz, "usedAt" timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id, "tenantId", "codeHash", "expiresAt", "usedAt" FROM "ConnectorPairing" $$;

REVOKE ALL ON FUNCTION resolve_tenant_by_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_site(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_session_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_recording_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_connector(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_active_tenant_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_connector_token_candidates() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_pairing_candidates() FROM PUBLIC;

SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') AS have_role \gset
\if :have_role
GRANT EXECUTE ON FUNCTION resolve_tenant_by_user(text) TO app;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_site(text) TO app;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_session_token(text) TO app;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_recording_key(text) TO app;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_connector(text) TO app;
GRANT EXECUTE ON FUNCTION list_active_tenant_ids() TO app;
GRANT EXECUTE ON FUNCTION list_connector_token_candidates() TO app;
GRANT EXECUTE ON FUNCTION list_pairing_candidates() TO app;
\endif

-- 8. Custom (BYO) vendor hostnames must be globally unique (managed hosts are
-- per-tenant-unique via the slug suffix; only customDomain hosts need this).
CREATE UNIQUE INDEX IF NOT EXISTS site_custom_hostname_uq ON "Site" (hostname) WHERE "customDomain";

-- 8. Platform console (Cloud): cross-tenant reads + tenant lifecycle. Same
-- contract as section 6 — RLS-bypass mechanics only; authorization is app-level
-- (requirePlatformAdmin). Read functions are STABLE; mutations refuse the
-- reserved tenants.
CREATE OR REPLACE FUNCTION platform_tenant_stats()
RETURNS TABLE(id text, users bigint, admins bigint, vendors bigint, sites bigint, connectors bigint, "connectorsOnline" bigint,
              "grantsActive" bigint, "requestsPending" bigint, "auditEvents" bigint, recordings bigint, "recordingBytes" numeric,
              "sessions24h" bigint, "lastActivity" timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT t.id,
    (SELECT count(*) FROM "User" u WHERE u."tenantId" = t.id),
    (SELECT count(*) FROM "User" u WHERE u."tenantId" = t.id AND u.role = 'ADMIN'),
    (SELECT count(*) FROM "User" u WHERE u."tenantId" = t.id AND u.role = 'VENDOR'),
    (SELECT count(*) FROM "Site" s WHERE s."tenantId" = t.id),
    (SELECT count(*) FROM "Connector" c WHERE c."tenantId" = t.id AND c.status <> 'REVOKED'),
    (SELECT count(*) FROM "Connector" c WHERE c."tenantId" = t.id AND c.status = 'ONLINE'),
    (SELECT count(*) FROM "AccessGrant" g WHERE g."tenantId" = t.id AND g.status = 'ACTIVE' AND (g."requiresApproval" = false OR g."approvedAt" IS NOT NULL) AND (g."endsAt" IS NULL OR g."endsAt" > now())),
    (SELECT count(*) FROM "AccessGrant" g WHERE g."tenantId" = t.id AND g.status = 'ACTIVE' AND g."requiresApproval" = true AND g."approvedAt" IS NULL),
    (SELECT count(*) FROM "AuditEvent" a WHERE a."tenantId" = t.id),
    (SELECT count(*) FROM "SessionRecording" r WHERE r."tenantId" = t.id),
    (SELECT coalesce(sum(r.bytes), 0) FROM "SessionRecording" r WHERE r."tenantId" = t.id),
    (SELECT count(*) FROM "Session" s WHERE s."tenantId" = t.id AND s."lastSeenAt" > now() - interval '24 hours'),
    (SELECT greatest(
        (SELECT max(a."timestamp") FROM "AuditEvent" a WHERE a."tenantId" = t.id),
        (SELECT max(s."lastSeenAt") FROM "Session" s WHERE s."tenantId" = t.id),
        (SELECT max(e."timestamp") FROM "AdminAuditEvent" e WHERE e."tenantId" = t.id)))
  FROM "Tenant" t
  WHERE t.id NOT IN ('platform', 'default')
$$;

CREATE OR REPLACE FUNCTION platform_find_users(p_email text)
RETURNS TABLE("tenantId" text, slug text, "tenantName" text, id text, email text, name text, role text, status text, "createdAt" timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT u."tenantId", t.slug, t.name, u.id, u.email, u.name, u.role::text, u.status::text, u."createdAt"
  FROM "User" u JOIN "Tenant" t ON t.id = u."tenantId"
  WHERE u.email ILIKE '%' || p_email || '%' AND t.id <> 'default'
  ORDER BY u."createdAt" DESC
  LIMIT 100
$$;

CREATE OR REPLACE FUNCTION platform_recent_admin_events(p_limit int, p_tenant text)
RETURNS TABLE("tenantId" text, slug text, id text, "timestamp" timestamptz, "actorEmail" text, action text, "targetType" text, "targetId" text, summary text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT e."tenantId", t.slug, e.id, e."timestamp", e."actorEmail", e.action, e."targetType", e."targetId", e.summary
  FROM "AdminAuditEvent" e JOIN "Tenant" t ON t.id = e."tenantId"
  WHERE (p_tenant IS NULL OR e."tenantId" = p_tenant) AND t.id <> 'default'
  ORDER BY e."timestamp" DESC
  LIMIT greatest(1, least(p_limit, 500))
$$;

CREATE OR REPLACE FUNCTION platform_recent_access_events(p_limit int, p_tenant text)
RETURNS TABLE("tenantId" text, slug text, id text, "timestamp" timestamptz, "userEmail" text, "siteName" text, host text, decision text, reason text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT a."tenantId", t.slug, a.id, a."timestamp", a."userEmail", a."siteName", a.host, a.decision::text, a.reason
  FROM "AuditEvent" a JOIN "Tenant" t ON t.id = a."tenantId"
  WHERE (p_tenant IS NULL OR a."tenantId" = p_tenant) AND t.id <> 'default'
  ORDER BY a."timestamp" DESC
  LIMIT greatest(1, least(p_limit, 500))
$$;

CREATE OR REPLACE FUNCTION platform_cron_runs()
RETURNS TABLE("tenantId" text, slug text, job text, "ranAt" timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c."tenantId", t.slug, c.job, c."ranAt"
  FROM "CronRun" c JOIN "Tenant" t ON t.id = c."tenantId"
  WHERE t.id <> 'default'
  ORDER BY t.slug, c.job
$$;

DROP FUNCTION IF EXISTS platform_expired_trials();

CREATE OR REPLACE FUNCTION platform_update_tenant(p_id text, p_name text, p_plan text, p_trial_ends timestamptz, p_limits jsonb, p_capabilities jsonb, p_notes text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_id IN ('platform', 'default') THEN RAISE EXCEPTION 'reserved tenant'; END IF;
  IF p_plan NOT IN ('standard', 'enterprise', 'free') THEN RAISE EXCEPTION 'invalid plan: %', p_plan; END IF;
  UPDATE "Tenant" SET name = p_name, plan = p_plan, "trialEndsAt" = p_trial_ends, limits = p_limits,
                      capabilities = p_capabilities, notes = p_notes, "updatedAt" = now()
  WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION platform_delete_tenant(p_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_id IN ('platform', 'default') THEN RAISE EXCEPTION 'reserved tenant'; END IF;
  UPDATE "Tenant" SET "deletedAt" = now(), status = 'SUSPENDED', "updatedAt" = now() WHERE id = p_id AND "deletedAt" IS NULL;
  DELETE FROM "Session" WHERE "tenantId" = p_id;
END $$;

CREATE OR REPLACE FUNCTION platform_restore_tenant(p_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_id IN ('platform', 'default') THEN RAISE EXCEPTION 'reserved tenant'; END IF;
  UPDATE "Tenant" SET "deletedAt" = NULL, status = 'ACTIVE', "updatedAt" = now() WHERE id = p_id;
END $$;

-- Hard delete: only a soft-deleted tenant; every tenant-scoped table cascades via FK.
CREATE OR REPLACE FUNCTION platform_purge_tenant(p_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_id IN ('platform', 'default') THEN RAISE EXCEPTION 'reserved tenant'; END IF;
  DELETE FROM "Tenant" WHERE id = p_id AND "deletedAt" IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION platform_purge_candidates(p_days int)
RETURNS SETOF text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id FROM "Tenant" WHERE "deletedAt" IS NOT NULL AND "deletedAt" < now() - make_interval(days => p_days) AND id NOT IN ('platform', 'default')
$$;


-- The platform tenant's SMTP settings, for the opt-in fallback used by tenants
-- that have not configured their own mail. Read by ANY tenant request; the
-- password is needed to send, so the caller must never echo it back to a UI.
CREATE OR REPLACE FUNCTION platform_smtp_config()
RETURNS TABLE(host text, port int, secure boolean, username text, password text, "fromName" text, "fromEmail" text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT host, port, secure, username, password, "fromName", "fromEmail" FROM "SmtpConfig" WHERE "tenantId" = 'platform' AND enabled = true
$$;

REVOKE ALL ON FUNCTION platform_tenant_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_find_users(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_recent_admin_events(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_recent_access_events(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_cron_runs() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_update_tenant(text, text, text, timestamptz, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_delete_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_restore_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_purge_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_purge_candidates(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_smtp_config() FROM PUBLIC;

SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') AS have_role \gset
\if :have_role
GRANT EXECUTE ON FUNCTION platform_tenant_stats() TO app;
GRANT EXECUTE ON FUNCTION platform_find_users(text) TO app;
GRANT EXECUTE ON FUNCTION platform_recent_admin_events(int, text) TO app;
GRANT EXECUTE ON FUNCTION platform_recent_access_events(int, text) TO app;
GRANT EXECUTE ON FUNCTION platform_cron_runs() TO app;
GRANT EXECUTE ON FUNCTION platform_update_tenant(text, text, text, timestamptz, jsonb, jsonb, text) TO app;
GRANT EXECUTE ON FUNCTION platform_delete_tenant(text) TO app;
GRANT EXECUTE ON FUNCTION platform_restore_tenant(text) TO app;
GRANT EXECUTE ON FUNCTION platform_purge_tenant(text) TO app;
GRANT EXECUTE ON FUNCTION platform_purge_candidates(int) TO app;
GRANT EXECUTE ON FUNCTION platform_smtp_config() TO app;
\endif
