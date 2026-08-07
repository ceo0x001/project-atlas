-- Row-level security, vector and search indexes.
--
-- Prisma does not model any of this, so it is applied as raw SQL appended to the
-- initial migration (see docs/DEVELOPMENT.md for the exact command sequence).
--
-- ============================================================================
-- Why this is not decoration
-- ============================================================================
-- The application already scopes every query by user_id. RLS is defence in depth:
-- one forgotten WHERE clause in a finance product is an unrecoverable event, and
-- "we were careful" is not a security control.
--
-- Two details make the difference between real isolation and false confidence:
--
--   1. FORCE ROW LEVEL SECURITY. Policies do not apply to a table's owner by
--      default. Migrations run as the owner; the application must NOT. Without
--      FORCE, an app connected as the owner silently bypasses every policy here.
--
--   2. The application connects as `atlas_app`, a role with no BYPASSRLS and no
--      ownership. Every transaction sets `atlas.user_id`, and the policy compares
--      against it. A transaction that forgets to set it sees zero rows — failing
--      closed, which is the only acceptable direction to fail.
--
-- The application-side wiring (SET LOCAL per transaction) lands in M1 alongside
-- the first real repository.

-- ============================================================================
-- Application role
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_app') THEN
    -- Password is set per environment; development uses the compose default.
    CREATE ROLE atlas_app LOGIN PASSWORD 'atlas_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO atlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO atlas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO atlas_app;

-- Tables created by future migrations inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atlas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO atlas_app;

-- ============================================================================
-- Tenant isolation policies
-- ============================================================================

-- Tables owned entirely by one user: a row is visible only when its user_id
-- matches the current transaction's setting.
DO $$
DECLARE
  target text;
  user_scoped_tables text[] := ARRAY[
    'devices',
    'consents',
    'accounts',
    'transactions',
    'transaction_observations',
    'parse_failures',
    'statement_imports',
    'insights',
    'insight_evidence',
    'recurring_series',
    'facts',
    'episodes',
    'conversation_sessions',
    'conversation_turns'
  ];
BEGIN
  FOREACH target IN ARRAY user_scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (user_id = current_setting(''atlas.user_id'', true))
         WITH CHECK (user_id = current_setting(''atlas.user_id'', true))',
      target
    );
  END LOOP;
END
$$;

-- The users table keys on `id` rather than `user_id`.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (id = current_setting('atlas.user_id', true))
  WITH CHECK (id = current_setting('atlas.user_id', true));

-- Categories and merchants hold both system rows (user_id IS NULL, readable by
-- everyone) and user-defined rows (readable only by their owner). Writes are
-- always restricted to the owner, so no user can modify a system row.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['categories', 'merchants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (user_id IS NULL OR user_id = current_setting(''atlas.user_id'', true))
         WITH CHECK (user_id = current_setting(''atlas.user_id'', true))',
      target
    );
  END LOOP;
END
$$;

-- Deliberately NOT under RLS: `institutions`, `parse_templates` and `fx_rates` are
-- shared reference data containing nothing user-specific. `outbox_events` is
-- infrastructure written and drained by the process itself, never served to a
-- client; it stays owner-only and is not granted to atlas_app for SELECT beyond
-- what the relay needs.

-- ============================================================================
-- Vector and search indexes
-- ============================================================================

-- HNSW for episodic recall. Cosine distance matches the embedding model's
-- similarity metric; the dimension must stay in step with EMBEDDING_DIMENSIONS
-- and the vector(1024) column (a schema test asserts the latter).
CREATE INDEX IF NOT EXISTS episodes_embedding_hnsw
  ON episodes USING hnsw (embedding vector_cosine_ops);

-- Trigram search over transaction descriptions, for "that transfer to Musa".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);
