-- Phase 0b-1: reshape tables in place BEFORE `prisma db push`, so db push (which
-- would otherwise need --accept-data-loss for the PK/unique changes) sees them
-- already matching and is a clean no-op. We never pass --accept-data-loss.
-- Idempotent + guarded: each block runs only while the old shape is present and
-- skips safely when a table does not exist yet (fresh install — db push then
-- creates the new shape directly).

-- 1. Config singletons: id ("singleton") PK -> tenantId PK (one row, tenantId='default').
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PlatformSettings','SmtpConfig','OidcConfig','DirectoryConfig','BrandingConfig','SessionPolicy','UpdateCheckConfig'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'id') THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_pkey');
      EXECUTE format('ALTER TABLE %I DROP COLUMN "id"', t);
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY ("tenantId")', t);
    END IF;
  END LOOP;
END $$;

-- 2. AuditChainState: id ('singleton'|'admin-singleton') -> (tenantId, scope).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AuditChainState' AND column_name = 'id') THEN
    ALTER TABLE "AuditChainState" ADD COLUMN IF NOT EXISTS "scope" text;
    UPDATE "AuditChainState" SET "scope" = CASE WHEN "id" = 'admin-singleton' THEN 'admin' ELSE 'access' END WHERE "scope" IS NULL;
    ALTER TABLE "AuditChainState" ALTER COLUMN "scope" SET NOT NULL;
    ALTER TABLE "AuditChainState" DROP CONSTRAINT "AuditChainState_pkey";
    ALTER TABLE "AuditChainState" DROP COLUMN "id";
    ALTER TABLE "AuditChainState" ADD PRIMARY KEY ("tenantId", "scope");
  END IF;
END $$;

-- 3. CronRun: job PK -> (tenantId, job). Nested guard so the regclass cast only
-- runs when the table exists; cast attname to text for the array comparison.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CronRun') THEN
    IF (SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = '"CronRun"'::regclass AND i.indisprimary) = ARRAY['job'] THEN
      ALTER TABLE "CronRun" DROP CONSTRAINT "CronRun_pkey";
      ALTER TABLE "CronRun" ADD PRIMARY KEY ("tenantId", "job");
    END IF;
  END IF;
END $$;

-- 4. Global uniques -> composite (tenantId, field). Drop the old single-field
-- unique index and create the composite one under Prisma's expected name
-- (<Table>_tenantId_<field>_key), so db push sees a match. Safe in single-tenant:
-- all rows share tenantId='default' and the field was already globally unique.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('User','email'), ('Passkey','credentialId'), ('Invite','tokenHash'),
    ('Session','tokenHash'), ('Connector','tokenHash'), ('Site','hostname'),
    ('AuditEvent','seq'), ('SessionRecording','recordingKey'), ('AdminAuditEvent','seq')
  ) AS v(tbl, col) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = r.tbl) THEN
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = r.tbl || '_' || r.col || '_key') THEN
        EXECUTE format('DROP INDEX %I', r.tbl || '_' || r.col || '_key');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = r.tbl || '_tenantId_' || r.col || '_key') THEN
        EXECUTE format('CREATE UNIQUE INDEX %I ON %I ("tenantId", %I)',
                       r.tbl || '_tenantId_' || r.col || '_key', r.tbl, r.col);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 4. Web app file transfer (2.20.0): Site.fileTransferMode was ISOLATED-only, so
-- every web app (TRANSPARENT) row holds the column default "none" that no admin
-- chose. Once the data-plane enforces it, that would cut every web app's
-- downloads and uploads. Before the column that ships with it exists (so once),
-- web apps go to null: inherit the Policy default, which is "allow".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'PlatformSettings')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PlatformSettings' AND column_name = 'webAppFileTransferDefault')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Site' AND column_name = 'fileTransferMode') THEN
    UPDATE "Site" SET "fileTransferMode" = NULL WHERE "accessMode" = 'TRANSPARENT';
  END IF;
END $$;
