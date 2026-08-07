

-- Remove mappings whose user no longer exists.
--
-- Adding the foreign key below fails outright if any orphan is present, so this is not
-- housekeeping — it is a precondition. Orphans are possible because `phone_identities` was
-- created without the constraint: a user deleted in that window left its mapping behind.
-- Such a row points at nothing and is worse than useless, since it makes the next sign-in on
-- that number fail instead of creating a fresh account.
DELETE FROM phone_identities p
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p."userId");

-- AddForeignKey
ALTER TABLE "phone_identities" ADD CONSTRAINT "phone_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
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
