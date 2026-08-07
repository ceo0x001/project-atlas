

-- CreateTable
CREATE TABLE "phone_identities" (
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_identities_pkey" PRIMARY KEY ("phoneE164")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_identities_userId_key" ON "phone_identities"("userId");

-- ============================================================================
-- phone_identities is deliberately NOT under row-level security.
-- ============================================================================
--
-- The third and last table with this exemption, alongside `device_credentials` and
-- `auth_challenges`, on the same bootstrap rationale: it is read to discover which
-- user a phone number belongs to, so gating it by that answer would be circular.
--
-- It exists precisely because `users` IS protected. The policy there is
-- `id = current_setting('atlas.user_id')`, so a lookup by phone number matches zero
-- rows — which would make an existing user's sign-in silently create a duplicate and
-- fail. This table holds a phone number and a user id and nothing else; `users`
-- itself stays fully protected.
GRANT SELECT, INSERT, UPDATE, DELETE ON phone_identities TO atlas_app;

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
--   1. Delete the `DROP INDEX` lines from the generated migration — but only those
--      naming an index defined *in this file*. Prisma also emits legitimate drops when
--      you intentionally remove an index from `schema.prisma`, and stripping those too
--      would leave dead indexes behind forever. Match on the names below, not on the
--      statement.
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

-- Outbox backlog. Partial on purpose: `outbox_events` accumulates every event ever
-- emitted, while the rows the relay cares about are only the undelivered ones. A full
-- index would grow with all history; this one stays proportional to the backlog, which
-- is what keeps the claim query cheap at scale.
CREATE INDEX IF NOT EXISTS outbox_events_backlog
  ON outbox_events ("nextAttemptAt", "occurredAt")
  WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL;

-- Supports pruning delivered rows without scanning the whole table.
CREATE INDEX IF NOT EXISTS outbox_events_published_at
  ON outbox_events ("publishedAt")
  WHERE "publishedAt" IS NOT NULL;
