-- CreateTable
CREATE TABLE "device_credentials" (
    "tokenHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_deviceId_key" ON "device_credentials"("deviceId");

-- CreateIndex
CREATE INDEX "device_credentials_userId_idx" ON "device_credentials"("userId");

-- AddForeignKey
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Appended from prisma/sql/managed-indexes.sql

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
