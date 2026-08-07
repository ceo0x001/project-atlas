import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

/**
 * Guards the hand-managed indexes.
 *
 * Prisma cannot express an HNSW or a trigram index, so it treats both as schema drift
 * and emits `DROP INDEX` in every migration it generates
 * (see prisma/sql/managed-indexes.sql). Losing one degrades silently: semantic recall
 * or transaction search quietly becomes a sequential scan and nothing fails, it just
 * gets slower and slower as real users accumulate data.
 *
 * This test is what turns that silent degradation into a red build.
 */

const env = parseEnv();
const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

afterAll(async () => {
  await owner.$disconnect();
});

interface IndexRow {
  readonly indexdef: string;
}

async function indexDefinition(name: string): Promise<string | null> {
  const rows = await owner.$queryRawUnsafe<IndexRow[]>(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
    'public',
    name,
  );

  return rows[0]?.indexdef ?? null;
}

describe('hand-managed indexes survive migration', () => {
  it('keeps the HNSW index for episodic memory recall', async () => {
    const definition = await indexDefinition('episodes_embedding_hnsw');

    expect(definition).not.toBeNull();
    expect(definition).toContain('hnsw');
    // Cosine must match the embedding model's similarity metric; another operator
    // class would return confidently wrong neighbours rather than an error.
    expect(definition).toContain('vector_cosine_ops');
  });

  it('keeps the trigram index for transaction search', async () => {
    const definition = await indexDefinition('transactions_description_trgm');

    expect(definition).not.toBeNull();
    expect(definition).toContain('gin');
    expect(definition).toContain('gin_trgm_ops');
  });

  it('has the extensions those indexes depend on', async () => {
    const rows = await owner.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname
    `;

    expect(rows.map((row) => row.extname)).toEqual(['pg_trgm', 'vector']);
  });
});

describe('row-level security covers every user-scoped table', () => {
  it('leaves no user-scoped table unprotected', async () => {
    // A new table with a userId column and no policy is a cross-tenant leak waiting
    // for its first query. Deriving the list from the schema rather than hard-coding
    // it means this test notices tables that do not exist yet.
    const unprotected = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname AND col.table_schema = n.nspname
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND col.column_name = 'userId'
        AND c.relrowsecurity = false
      ORDER BY c.relname
    `;

    // `device_credentials` is the single deliberate exemption: it is the table that
    // establishes which tenant is calling, so it cannot be gated by tenancy.
    // `outbox_events` is infrastructure, written and drained by the process itself
    // and never served to a client.
    expect(unprotected.map((row) => row.table_name)).toEqual([
      'device_credentials',
      'outbox_events',
    ]);
  });

  it('forces policies on the table owner, not just on other roles', async () => {
    // Without FORCE, an app that happens to connect as the table owner bypasses
    // every policy — which is exactly how RLS ends up being decorative.
    const notForced = await owner.$queryRaw<{ relname: string }[]>`
      SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r'
        AND relrowsecurity = true
        AND relforcerowsecurity = false
      ORDER BY relname
    `;

    expect(notForced).toEqual([]);
  });
});
