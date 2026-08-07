-- CreateEnum
CREATE TYPE "ReconciliationKind" AS ENUM ('MERGE', 'SPLIT', 'GAP_FLAGGED');

-- CreateEnum
CREATE TYPE "ReconciliationActor" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "SuspectedDuplicateResolution" AS ENUM ('MERGED', 'KEPT_SEPARATE');

-- CreateEnum
CREATE TYPE "SuspectedGapResolution" AS ENUM ('EXPLAINED', 'DISMISSED');



-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "supersededByTransactionId" TEXT;

-- CreateTable
CREATE TABLE "reconciliation_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ReconciliationKind" NOT NULL,
    "decidedBy" "ReconciliationActor" NOT NULL,
    "survivingTransactionId" TEXT,
    "absorbedTransactionId" TEXT,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspected_duplicates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leftTransactionId" TEXT NOT NULL,
    "rightTransactionId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "resolution" "SuspectedDuplicateResolution",
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suspected_duplicates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspected_gaps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "missingDirection" "TransactionDirection" NOT NULL,
    "afterTransactionId" TEXT NOT NULL,
    "beforeTransactionId" TEXT NOT NULL,
    "afterAt" TIMESTAMPTZ(3) NOT NULL,
    "beforeAt" TIMESTAMPTZ(3) NOT NULL,
    "resolution" "SuspectedGapResolution",
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suspected_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_events_userId_createdAt_idx" ON "reconciliation_events"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "suspected_duplicates_userId_resolution_idx" ON "suspected_duplicates"("userId", "resolution");

-- CreateIndex
CREATE UNIQUE INDEX "suspected_duplicates_userId_leftTransactionId_rightTransact_key" ON "suspected_duplicates"("userId", "leftTransactionId", "rightTransactionId");

-- CreateIndex
CREATE INDEX "suspected_gaps_userId_resolution_idx" ON "suspected_gaps"("userId", "resolution");

-- CreateIndex
CREATE UNIQUE INDEX "suspected_gaps_userId_accountId_afterTransactionId_beforeTr_key" ON "suspected_gaps"("userId", "accountId", "afterTransactionId", "beforeTransactionId");

-- CreateIndex
CREATE INDEX "transactions_userId_supersededByTransactionId_idx" ON "transactions"("userId", "supersededByTransactionId");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_supersededByTransactionId_fkey" FOREIGN KEY ("supersededByTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_events" ADD CONSTRAINT "reconciliation_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspected_duplicates" ADD CONSTRAINT "suspected_duplicates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspected_gaps" ADD CONSTRAINT "suspected_gaps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspected_gaps" ADD CONSTRAINT "suspected_gaps_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-level security for the reconciliation tables.
-- ============================================================================
--
-- Appended by hand because Prisma has no notion of policies. Every new user-scoped
-- table needs this or it is readable across tenants: RLS is not inherited, and a
-- table without an explicit policy simply has none.
--
-- FORCE ROW LEVEL SECURITY is what makes it hold for the table owner too, and the
-- app connects as the non-superuser `atlas_app` role so it cannot opt out.
--
-- NOTE ON QUOTING: Prisma generates camelCase columns, so "userId" must be quoted.
DO $$
DECLARE
  target text;
  user_scoped_tables text[] := ARRAY[
    'reconciliation_events',
    'suspected_duplicates',
    'suspected_gaps'
  ];
BEGIN
  FOREACH target IN ARRAY user_scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("userId" = current_setting(''atlas.user_id'', true))
         WITH CHECK ("userId" = current_setting(''atlas.user_id'', true))',
      target
    );
  END LOOP;
END
$$;

-- Grants for tables created after the RLS migration ran. ALTER DEFAULT PRIVILEGES
-- covers future tables created by the same role, but being explicit costs nothing and
-- survives a role change.
GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation_events TO atlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON suspected_duplicates TO atlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON suspected_gaps TO atlas_app;

-- Hand-managed indexes.
--
-- ============================================================================
-- APPEND THIS FILE TO EVERY GENERATED MIGRATION.
-- ============================================================================
--
-- Prisma cannot express these index types, so they live here rather than in
-- schema.prisma. The consequence is that Prisma sees them as schema drift and emits
-- `DROP INDEX` for them in *every* migration it generates. That is not a one-off
-- annoyance — it is a standing trap: forget once and semantic recall silently falls
-- back to a sequential scan over every episode, or transaction search does.
--
-- Two defences, deliberately overlapping:
--
--   1. Delete the `DROP INDEX` lines from the generated migration.
--   2. Append this file to it anyway. Every statement is `IF NOT EXISTS`, so it is
--      safe to run repeatedly and it self-heals if step 1 was missed — the index is
--      simply rebuilt inside the same transaction.
--
-- `test/schema-indexes.integration.test.ts` asserts both indexes exist, so a
-- migration that loses them fails CI rather than quietly degrading production.

-- Episodic memory recall. Cosine distance matches the embedding model's similarity
-- metric; the dimension must stay in step with EMBEDDING_DIMENSIONS and the
-- vector(1024) column.
CREATE INDEX IF NOT EXISTS episodes_embedding_hnsw
  ON episodes USING hnsw (embedding vector_cosine_ops);

-- Trigram search over transaction descriptions, for "that transfer to Musa".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);
