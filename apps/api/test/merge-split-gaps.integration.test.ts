import { PrismaClient } from '@prisma/client';
import {
  idFromSeed,
  type ObservationId,
  type TransactionId,
  type UserId,
} from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { DuplicateResolutionService } from '../src/modules/ledger/application/duplicate-resolution.service';
import { GapDetectionService } from '../src/modules/ledger/application/gap-detection.service';
import { ReconciliationService } from '../src/modules/ledger/application/reconciliation.service';
import type { LedgerQueryPlan } from '../src/modules/ledger/domain/ledger-query';
import { PrismaLedgerQueryRepository } from '../src/modules/ledger/infrastructure/prisma-ledger-query.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * Merge, split and gap detection against real rows.
 *
 * These close the paths the milestone tests do not reach. `merge()` supersedes an entire
 * transaction, which admission's attach path never does; `split()` is the recovery route
 * for a wrong merge, and without it an over-merge would hide money permanently. Both are
 * exercised here rather than left as code that merely looks finished.
 *
 * Requires `pnpm infra:up` and an applied migration.
 */

const userId = idFromSeed<'UserId'>(13_000) as UserId;
const accountId = idFromSeed<'AccountId'>(13_100);

const env = parseEnv();

const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const tenantScope = new TenantScope(app);
const reconciliation = new ReconciliationService();
const duplicates = new DuplicateResolutionService(tenantScope, reconciliation);
const gapDetection = new GapDetectionService(tenantScope);
const repository = new PrismaLedgerQueryRepository(tenantScope);

let seed = 0;

/** Creates a transaction with one observation, the shape admission produces. */
async function transactionWith(spec: {
  amountMinor: bigint;
  occurredAt: string;
  balanceAfterMinor?: bigint | null;
  description?: string;
  source?: 'SMS' | 'STATEMENT';
  direction?: 'DEBIT' | 'CREDIT';
}): Promise<{ transactionId: TransactionId; observationId: ObservationId }> {
  seed += 1;
  const transactionId = idFromSeed<'TransactionId'>(13_200 + seed);
  const observationId = idFromSeed<'ObservationId'>(13_600 + seed);
  const occurredAt = new Date(spec.occurredAt);
  const direction = spec.direction ?? 'DEBIT';

  await owner.transaction.create({
    data: {
      id: transactionId,
      userId,
      accountId,
      amountMinor: spec.amountMinor,
      currency: 'NGN',
      direction,
      occurredAt,
      description: spec.description ?? 'Unlabelled transaction',
      balanceAfterMinor: spec.balanceAfterMinor ?? null,
      status: 'POSTED',
    },
  });

  await owner.transactionObservation.create({
    data: {
      id: observationId,
      userId,
      accountId,
      transactionId,
      source: spec.source ?? 'SMS',
      amountMinor: spec.amountMinor,
      currency: 'NGN',
      direction,
      occurredAt,
      observedAt: occurredAt,
      balanceAfterMinor: spec.balanceAfterMinor ?? null,
      description: spec.description ?? null,
      dedupeKey: `${'0'.repeat(60)}${(2000 + seed).toString(16).padStart(4, '0')}`,
    },
  });

  return { transactionId, observationId };
}

function plan(): LedgerQueryPlan {
  return {
    userId,
    timezone: 'Africa/Lagos',
    metrics: ['total', 'count'],
    filter: {
      currency: 'NGN',
      direction: 'DEBIT',
      occurredFrom: new Date('2026-08-01T00:00:00Z'),
      occurredTo: new Date('2026-08-31T23:59:59Z'),
    },
  };
}

async function wipe(): Promise<void> {
  await owner.reconciliationEvent.deleteMany({ where: { userId } });
  await owner.suspectedDuplicate.deleteMany({ where: { userId } });
  await owner.suspectedGap.deleteMany({ where: { userId } });
  await owner.transactionObservation.deleteMany({ where: { userId } });
  await owner.transaction.updateMany({
    where: { userId },
    data: { supersededByTransactionId: null },
  });
  await owner.transaction.deleteMany({ where: { userId } });
}

beforeAll(async () => {
  await wipe();
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });

  await owner.user.create({
    data: { id: userId, phoneE164: '+2348000013000', timezone: 'Africa/Lagos' },
  });
  await owner.account.create({
    data: { id: accountId, userId, label: 'Current', type: 'CURRENT', currency: 'NGN' },
  });
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
  await owner.$disconnect();
  await app.$disconnect();
});

describe('merge — superseding a whole transaction', () => {
  it('moves the observations, supersedes the absorbed row and re-projects the survivor', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
      description: 'POS PURCHASE AT SHOPRITE',
      source: 'SMS',
    });
    const absorbed = await transactionWith({
      amountMinor: 499_900n,
      occurredAt: '2026-08-08T00:00:00Z',
      description: 'POS/1234/TRF',
      source: 'STATEMENT',
    });

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, survivor.transactionId, absorbed.transactionId, {
        balanceEqual: true,
      }),
    );

    const merged = await owner.transaction.findUniqueOrThrow({
      where: { id: survivor.transactionId },
      include: { observations: true },
    });

    expect(merged.observations).toHaveLength(2);
    // Re-projected, not left as it was: the statement outranks the alert on amount...
    expect(merged.amountMinor).toBe(499_900n);
    // ...while the alert still wins on time and narration.
    expect(merged.occurredAt).toEqual(new Date('2026-08-07T10:00:00Z'));
    expect(merged.description).toBe('POS PURCHASE AT SHOPRITE');

    const gone = await owner.transaction.findUniqueOrThrow({
      where: { id: absorbed.transactionId },
    });
    expect(gone.supersededByTransactionId).toBe(survivor.transactionId);
  });

  it('counts the money once afterwards', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
    });
    const absorbed = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:05Z',
    });

    const before = await repository.aggregate(plan());
    expect(before.rows[0]?.total.minor).toBe(1_000_000n);

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, survivor.transactionId, absorbed.transactionId, {}),
    );

    const after = await repository.aggregate(plan());
    expect(after.rows[0]?.total.minor).toBe(500_000n);
    expect(after.rows[0]?.count).toBe(1);
  });

  it('records the merge with its evidence and who decided it', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
    });
    const absorbed = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:05Z',
    });

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(
        tx,
        userId,
        survivor.transactionId,
        absorbed.transactionId,
        { balanceEqual: true, secondsApart: 5 },
        'SYSTEM',
      ),
    );

    const [event, ...rest] = await owner.reconciliationEvent.findMany({ where: { userId } });

    expect(rest).toEqual([]);
    expect(event?.kind).toBe('MERGE');
    expect(event?.decidedBy).toBe('SYSTEM');
    expect(event?.survivingTransactionId).toBe(survivor.transactionId);
    expect(event?.absorbedTransactionId).toBe(absorbed.transactionId);
    expect(event?.evidence).toMatchObject({ balanceEqual: true, secondsApart: 5 });
  });
});

describe('split — the recovery path for a wrong merge', () => {
  it('moves an observation onto a new transaction and re-projects both', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
      description: 'POS PURCHASE AT SHOPRITE',
      source: 'SMS',
    });
    const absorbed = await transactionWith({
      amountMinor: 499_900n,
      occurredAt: '2026-08-08T00:00:00Z',
      description: 'POS/1234/TRF',
      source: 'STATEMENT',
    });

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, survivor.transactionId, absorbed.transactionId, {}),
    );

    // The merge was wrong: these were two different purchases.
    const result = await tenantScope.run(userId, (tx) =>
      reconciliation.split(tx, userId, absorbed.observationId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restored = await owner.transaction.findUniqueOrThrow({
      where: { id: result.value },
      include: { observations: true },
    });

    // Projected from its single observation, so the statement's own figures come back.
    expect(restored.observations).toHaveLength(1);
    expect(restored.amountMinor).toBe(499_900n);
    expect(restored.description).toBe('POS/1234/TRF');
    expect(restored.occurredAt).toEqual(new Date('2026-08-08T00:00:00Z'));

    // The original is back to its own evidence alone.
    const original = await owner.transaction.findUniqueOrThrow({
      where: { id: survivor.transactionId },
      include: { observations: true },
    });
    expect(original.observations).toHaveLength(1);
    expect(original.amountMinor).toBe(500_000n);
    expect(original.description).toBe('POS PURCHASE AT SHOPRITE');
  });

  it('brings the hidden money back into the total', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
    });
    const absorbed = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:05Z',
    });

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, survivor.transactionId, absorbed.transactionId, {}),
    );
    expect((await repository.aggregate(plan())).rows[0]?.total.minor).toBe(500_000n);

    await tenantScope.run(userId, (tx) => reconciliation.split(tx, userId, absorbed.observationId));

    // The whole reason split exists: an over-merge is recoverable rather than permanent.
    expect((await repository.aggregate(plan())).rows[0]?.total.minor).toBe(1_000_000n);
  });

  /**
   * A split always creates a new transaction rather than reviving the superseded row.
   * Reviving an id whose absorption other records already reference would make the audit
   * trail contradict itself.
   */
  it('leaves the superseded row superseded', async () => {
    const survivor = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
    });
    const absorbed = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:05Z',
    });

    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, survivor.transactionId, absorbed.transactionId, {}),
    );
    const result = await tenantScope.run(userId, (tx) =>
      reconciliation.split(tx, userId, absorbed.observationId),
    );

    const old = await owner.transaction.findUniqueOrThrow({
      where: { id: absorbed.transactionId },
    });

    expect(old.supersededByTransactionId).toBe(survivor.transactionId);
    if (result.ok) expect(result.value).not.toBe(absorbed.transactionId);
  });

  it('refuses to split a transaction down to no evidence', async () => {
    const only = await transactionWith({
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
    });

    const result = await tenantScope.run(userId, (tx) =>
      reconciliation.split(tx, userId, only.observationId),
    );

    expect(result).toEqual({ ok: false, error: 'only-observation' });
  });

  it('reports an unknown observation rather than throwing', async () => {
    const result = await tenantScope.run(userId, (tx) =>
      reconciliation.split(tx, userId, idFromSeed<'ObservationId'>(99_999)),
    );

    expect(result).toEqual({ ok: false, error: 'observation-not-found' });
  });
});

describe('resolving a suspected duplicate', () => {
  async function queuePair() {
    const left = await transactionWith({
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T10:00:00Z',
    });
    const right = await transactionWith({
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T18:00:00Z',
    });

    const [a, b] =
      left.transactionId < right.transactionId
        ? [left.transactionId, right.transactionId]
        : [right.transactionId, left.transactionId];

    await tenantScope.run(userId, (tx) =>
      reconciliation.queueSuspectedDuplicate(tx, userId, a, b, { secondsApart: 28_800 }),
    );

    const queued = await owner.suspectedDuplicate.findFirstOrThrow({ where: { userId } });
    return { queued, surviving: a, absorbed: b };
  }

  it('lists the pair as pending', async () => {
    await queuePair();

    const pending = await duplicates.pending(userId);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidence).toMatchObject({ secondsApart: 28_800 });
  });

  it('merges on MERGED and attributes the decision to the user', async () => {
    const { queued, surviving, absorbed } = await queuePair();

    expect(await duplicates.resolve(userId, queued.id, 'MERGED')).toBe('resolved');

    const merged = await owner.transaction.findUniqueOrThrow({ where: { id: absorbed } });
    expect(merged.supersededByTransactionId).toBe(surviving);

    const [event] = await owner.reconciliationEvent.findMany({ where: { userId } });
    expect(event?.decidedBy).toBe('USER');

    expect((await repository.aggregate(plan())).rows[0]?.count).toBe(1);
    expect(await duplicates.pending(userId)).toEqual([]);
  });

  it('keeps both on KEPT_SEPARATE and stops asking', async () => {
    const { queued } = await queuePair();

    expect(await duplicates.resolve(userId, queued.id, 'KEPT_SEPARATE')).toBe('resolved');

    expect((await repository.aggregate(plan())).rows[0]?.count).toBe(2);
    expect(await duplicates.pending(userId)).toEqual([]);
    expect(await owner.reconciliationEvent.findMany({ where: { userId } })).toEqual([]);
  });

  it('refuses a second, possibly contradictory answer', async () => {
    const { queued } = await queuePair();

    await duplicates.resolve(userId, queued.id, 'KEPT_SEPARATE');

    expect(await duplicates.resolve(userId, queued.id, 'MERGED')).toBe('already-resolved');
  });

  it('reports an unknown duplicate without revealing whether it exists elsewhere', async () => {
    expect(await duplicates.resolve(userId, idFromSeed<'InsightId'>(99_998), 'MERGED')).toBe(
      'not-found',
    );
  });
});

describe('gap detection over real transactions', () => {
  /** 1,000,000 then a 200,000 debit should leave 800,000; the bank says 680,000. */
  async function seedGap() {
    await transactionWith({
      amountMinor: 200_000n,
      occurredAt: '2026-08-01T09:00:00Z',
      balanceAfterMinor: 1_000_000n,
    });
    await transactionWith({
      amountMinor: 200_000n,
      occurredAt: '2026-08-03T09:00:00Z',
      balanceAfterMinor: 680_000n,
    });
  }

  it('finds unexplained spending between two balance readings', async () => {
    await seedGap();

    const gaps = await gapDetection.openGaps(userId, accountId, 'NGN');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.amount.minor).toBe(120_000n);
    expect(gaps[0]?.missingDirection).toBe('DEBIT');
  });

  it('creates no transaction for the missing money', async () => {
    await seedGap();
    await gapDetection.openGaps(userId, accountId, 'NGN');

    // The whole point: a gap is a question. Materialising it would put a figure in the
    // ledger that no source ever reported.
    const count = await owner.transaction.count({ where: { userId } });
    expect(count).toBe(2);
    expect((await repository.aggregate(plan())).rows[0]?.total.minor).toBe(400_000n);
  });

  it('stops reporting a gap once the user has dismissed it', async () => {
    await seedGap();

    const [gap] = await gapDetection.openGaps(userId, accountId, 'NGN');
    if (!gap) throw new Error('expected a gap to dismiss');

    const recorded = await gapDetection.resolve(
      userId,
      accountId,
      'NGN',
      gap.afterTransactionId,
      gap.beforeTransactionId,
      'DISMISSED',
    );

    expect(recorded).toBe(true);
    expect(await gapDetection.openGaps(userId, accountId, 'NGN')).toEqual([]);
  });

  /**
   * The table stores decisions, not gaps — so a resolution for a pair that has no gap must
   * be refused, or a real gap appearing between them later would arrive pre-dismissed.
   */
  it('refuses to record a decision about a gap that does not exist', async () => {
    const a = await transactionWith({
      amountMinor: 100_000n,
      occurredAt: '2026-08-01T09:00:00Z',
      balanceAfterMinor: 1_000_000n,
    });
    const b = await transactionWith({
      amountMinor: 100_000n,
      occurredAt: '2026-08-02T09:00:00Z',
      balanceAfterMinor: 900_000n,
    });

    const recorded = await gapDetection.resolve(
      userId,
      accountId,
      'NGN',
      a.transactionId,
      b.transactionId,
      'DISMISSED',
    );

    expect(recorded).toBe(false);
    expect(await owner.suspectedGap.count({ where: { userId } })).toBe(0);
  });

  it('ignores superseded rows, so a resolved merge does not look like a gap', async () => {
    const first = await transactionWith({
      amountMinor: 200_000n,
      occurredAt: '2026-08-01T09:00:00Z',
      balanceAfterMinor: 1_000_000n,
    });
    const duplicate = await transactionWith({
      amountMinor: 200_000n,
      occurredAt: '2026-08-01T09:00:01Z',
      balanceAfterMinor: 1_000_000n,
    });
    await transactionWith({
      amountMinor: 200_000n,
      occurredAt: '2026-08-03T09:00:00Z',
      balanceAfterMinor: 800_000n,
    });

    // Counting the duplicate would make the chain short by 200,000 and invent a gap.
    await tenantScope.run(userId, (tx) =>
      reconciliation.merge(tx, userId, first.transactionId, duplicate.transactionId, {}),
    );

    expect(await gapDetection.openGaps(userId, accountId, 'NGN')).toEqual([]);
  });
});
