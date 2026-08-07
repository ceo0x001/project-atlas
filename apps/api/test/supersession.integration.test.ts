import { PrismaClient } from '@prisma/client';
import { idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import type { LedgerQueryPlan } from '../src/modules/ledger/domain/ledger-query';
import { PrismaLedgerQueryRepository } from '../src/modules/ledger/infrastructure/prisma-ledger-query.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * Proves risk R10 is actually closed — in SQL, against real rows.
 *
 * The unit guard test asserts the predicate appears in every query the compiler emits.
 * That is necessary but not sufficient: a predicate can be present and still not work
 * (`= NULL` never matches anything, for instance). This runs the real query against a
 * superseded row and checks the money is gone from the total.
 *
 * It also proves the reconciliation tables are under row-level security. RLS is not
 * inherited by new tables — a table created without an explicit policy has none — so
 * every added table needs this checked rather than assumed.
 *
 * Requires `pnpm infra:up` and an applied migration.
 */

const userOne = idFromSeed<'UserId'>(7_000) as UserId;
const userTwo = idFromSeed<'UserId'>(7_500) as UserId;
const accountOne = idFromSeed<'AccountId'>(7_100);

const survivor = idFromSeed<'TransactionId'>(7_200);
const absorbed = idFromSeed<'TransactionId'>(7_300);

const env = parseEnv();

/** Owner connection: bypasses RLS, so it can seed and assert across tenants. */
const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const tenantScope = new TenantScope(app);
const repository = new PrismaLedgerQueryRepository(tenantScope);

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    userId: userOne,
    timezone: 'Africa/Lagos',
    metrics: ['total', 'count'],
    filter: {
      currency: 'NGN',
      direction: 'DEBIT',
      occurredFrom: new Date('2026-08-01T00:00:00Z'),
      occurredTo: new Date('2026-08-31T23:59:59Z'),
      ...overrides.filter,
    },
    ...overrides,
  };
}

async function wipe(): Promise<void> {
  const users = { in: [userOne, userTwo] };
  await owner.reconciliationEvent.deleteMany({ where: { userId: users } });
  await owner.suspectedDuplicate.deleteMany({ where: { userId: users } });
  await owner.suspectedGap.deleteMany({ where: { userId: users } });
  // Clear the self-reference before deleting, or the FK blocks the delete.
  await owner.transaction.updateMany({
    where: { userId: users },
    data: { supersededByTransactionId: null },
  });
  await owner.transaction.deleteMany({ where: { userId: users } });
  await owner.account.deleteMany({ where: { userId: users } });
  await owner.user.deleteMany({ where: { id: { in: [userOne, userTwo] } } });
}

beforeAll(async () => {
  await wipe();

  await owner.user.createMany({
    data: [
      { id: userOne, phoneE164: '+2348000007000', timezone: 'Africa/Lagos' },
      { id: userTwo, phoneE164: '+2348000007500', timezone: 'Africa/Lagos' },
    ],
  });

  await owner.account.create({
    data: {
      id: accountOne,
      userId: userOne,
      label: 'Current',
      type: 'CURRENT',
      currency: 'NGN',
    },
  });

  // Two rows describing the same ₦5,000 purchase: one canonical, one absorbed by it.
  await owner.transaction.createMany({
    data: [
      {
        id: survivor,
        userId: userOne,
        accountId: accountOne,
        amountMinor: 500_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-07T10:00:00Z'),
        description: 'POS PURCHASE AT SHOPRITE',
        status: 'POSTED',
      },
      {
        id: absorbed,
        userId: userOne,
        accountId: accountOne,
        amountMinor: 500_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-07T10:00:00Z'),
        description: 'POS/1234/SHOPRITE',
        status: 'POSTED',
      },
    ],
  });
});

afterAll(async () => {
  await wipe();
  await owner.$disconnect();
  await app.$disconnect();
});

describe('supersession excludes absorbed transactions from totals (R10)', () => {
  it('counts both rows while neither is superseded', async () => {
    await owner.transaction.update({
      where: { id: absorbed },
      data: { supersededByTransactionId: null },
    });

    const result = await repository.aggregate(plan());

    // The pre-merge state: the duplicate is visible, which is the recoverable failure.
    expect(result.rows[0]?.total.minor).toBe(1_000_000n);
    expect(result.rows[0]?.count).toBe(2);
  });

  /**
   * The assertion that matters. Before this predicate existed, the same money appeared
   * twice and the total read ₦10,000 for a single ₦5,000 purchase.
   */
  it('drops the absorbed row from the total once superseded', async () => {
    await owner.transaction.update({
      where: { id: absorbed },
      data: { supersededByTransactionId: survivor },
    });

    const result = await repository.aggregate(plan());

    expect(result.rows[0]?.total.minor).toBe(500_000n);
    expect(result.rows[0]?.count).toBe(1);
  });

  it('keeps the absorbed row addressable, so past explanations still resolve', async () => {
    const stillThere = await owner.transaction.findUnique({ where: { id: absorbed } });

    expect(stillThere).not.toBeNull();
    expect(stillThere?.supersededByTransactionId).toBe(survivor);
  });

  it('excludes it from the transaction list as well as the aggregate', async () => {
    const listed = await repository.listTransactions(plan({ limit: 50 }));

    expect(listed.map((row) => row.id)).toEqual([survivor]);
  });
});

describe('reconciliation tables are under row-level security', () => {
  it('hides another tenant’s reconciliation events', async () => {
    await owner.reconciliationEvent.createMany({
      data: [
        {
          id: idFromSeed<'EventId'>(7_600),
          userId: userOne,
          kind: 'MERGE',
          decidedBy: 'SYSTEM',
          survivingTransactionId: survivor,
          absorbedTransactionId: absorbed,
          evidence: { referenceEqual: false, balanceEqual: true, secondsApart: 0 },
        },
        {
          id: idFromSeed<'EventId'>(7_700),
          userId: userTwo,
          kind: 'MERGE',
          decidedBy: 'SYSTEM',
          evidence: {},
        },
      ],
    });

    const seenByUserOne = await tenantScope.run(userOne, (tx) =>
      tx.reconciliationEvent.findMany({}),
    );

    expect(seenByUserOne).toHaveLength(1);
    expect(seenByUserOne[0]?.userId).toBe(userOne);
  });

  it('refuses to write a reconciliation event for another tenant', async () => {
    await expect(
      tenantScope.run(userOne, (tx) =>
        tx.reconciliationEvent.create({
          data: {
            id: idFromSeed<'EventId'>(7_800),
            userId: userTwo,
            kind: 'MERGE',
            decidedBy: 'SYSTEM',
            evidence: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('hides another tenant’s suspected gaps', async () => {
    await owner.suspectedGap.create({
      data: {
        id: idFromSeed<'InsightId'>(7_900),
        userId: userTwo,
        accountId: accountOne,
        currency: 'NGN',
        amountMinor: 120_000n,
        missingDirection: 'DEBIT',
        afterTransactionId: survivor,
        beforeTransactionId: absorbed,
        afterAt: new Date('2026-08-01T09:00:00Z'),
        beforeAt: new Date('2026-08-03T09:00:00Z'),
      },
    });

    const seenByUserOne = await tenantScope.run(userOne, (tx) => tx.suspectedGap.findMany({}));

    expect(seenByUserOne).toEqual([]);
  });
});
