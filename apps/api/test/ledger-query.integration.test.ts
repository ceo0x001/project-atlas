import { PrismaClient } from '@prisma/client';
import { idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import type { LedgerQueryPlan } from '../src/modules/ledger/domain/ledger-query';
import { PrismaLedgerQueryRepository } from '../src/modules/ledger/infrastructure/prisma-ledger-query.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * Proves the query compiler's SQL actually executes, and that row-level security
 * holds when reached through application code rather than psql.
 *
 * Requires `pnpm infra:up` and an applied migration.
 */

const userOne = idFromSeed<'UserId'>(1_000) as UserId;
const userTwo = idFromSeed<'UserId'>(2_000) as UserId;

const accountOne = idFromSeed<'AccountId'>(1_100);
const accountTwo = idFromSeed<'AccountId'>(2_100);

const categoryFood = idFromSeed<'CategoryId'>(1_200);
const categoryTransport = idFromSeed<'CategoryId'>(1_300);

const env = parseEnv();

/** Owner connection: bypasses RLS, so it can seed and clean up across tenants. */
const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const repository = new PrismaLedgerQueryRepository(new TenantScope(app));

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    userId: userOne,
    timezone: 'Africa/Lagos',
    metrics: ['total', 'count', 'average', 'min', 'max'],
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
  await owner.transaction.deleteMany({ where: { userId: { in: [userOne, userTwo] } } });
  await owner.account.deleteMany({ where: { userId: { in: [userOne, userTwo] } } });
  await owner.category.deleteMany({ where: { userId: { in: [userOne, userTwo] } } });
  await owner.user.deleteMany({ where: { id: { in: [userOne, userTwo] } } });
}

beforeAll(async () => {
  await wipe();

  await owner.user.createMany({
    data: [
      { id: userOne, phoneE164: '+2348000001000', timezone: 'Africa/Lagos' },
      { id: userTwo, phoneE164: '+2348000002000', timezone: 'Africa/Lagos' },
    ],
  });

  await owner.account.createMany({
    data: [
      {
        id: accountOne,
        userId: userOne,
        label: 'Current',
        type: 'CURRENT',
        currency: 'NGN',
        currentBalanceMinor: 4_520_015n,
        balanceAsOf: new Date('2026-08-31T22:00:00Z'),
      },
      { id: accountTwo, userId: userTwo, label: 'Savings', type: 'SAVINGS', currency: 'NGN' },
    ],
  });

  await owner.category.createMany({
    data: [
      { id: categoryFood, userId: userOne, slug: 'food', name: 'Food' },
      { id: categoryTransport, userId: userOne, slug: 'transport', name: 'Transport' },
    ],
  });

  await owner.transaction.createMany({
    data: [
      {
        id: idFromSeed<'TransactionId'>(1_401),
        userId: userOne,
        accountId: accountOne,
        amountMinor: 500_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-07T13:23:45Z'), // 14:23 Lagos
        description: 'SHOPRITE GROCERIES',
        categoryId: categoryFood,
      },
      {
        id: idFromSeed<'TransactionId'>(1_402),
        userId: userOne,
        accountId: accountOne,
        amountMinor: 250_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-07T22:30:00Z'), // 23:30 Lagos, same local day
        description: 'LATE NIGHT SUYA',
        categoryId: categoryFood,
      },
      {
        id: idFromSeed<'TransactionId'>(1_403),
        userId: userOne,
        accountId: accountOne,
        amountMinor: 100_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-10T09:00:00Z'),
        description: '50% off promo ride',
        categoryId: categoryFood,
      },
      {
        id: idFromSeed<'TransactionId'>(1_404),
        userId: userOne,
        accountId: accountOne,
        amountMinor: 1_000_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        // 23:30 UTC on 31 Aug is 00:30 on 1 SEPTEMBER in Lagos. Bucketing in UTC
        // would file this under August and quietly corrupt every monthly total.
        occurredAt: new Date('2026-08-31T23:30:00Z'),
        description: 'BOLT RIDE',
        categoryId: categoryTransport,
      },
      {
        id: idFromSeed<'TransactionId'>(1_405),
        userId: userOne,
        accountId: accountOne,
        amountMinor: 25_000_000n,
        currency: 'NGN',
        direction: 'CREDIT',
        occurredAt: new Date('2026-08-25T08:05:00Z'),
        description: 'SALARY AUGUST',
      },
      {
        id: idFromSeed<'TransactionId'>(2_401),
        userId: userTwo,
        accountId: accountTwo,
        amountMinor: 999_999n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        description: 'PRIVATE TO USER TWO',
      },
    ],
  });
});

afterAll(async () => {
  await wipe();
  await owner.$disconnect();
  await app.$disconnect();
});

describe('the compiled SQL executes against Postgres', () => {
  it('totals debits exactly, in kobo', () => {
    // 500000 + 250000 + 100000 + 1000000
    return repository.aggregate(plan()).then((result) => {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.total.toDecimalString()).toBe('18500.00');
      expect(result.rows[0]!.count).toBe(4);
    });
  });

  it('excludes credits when the plan filters to debits', async () => {
    const result = await repository.aggregate(plan());

    // The 250,000 naira salary must not appear in a spending total.
    expect(result.rows[0]!.total.minor).toBe(1_850_000n);
  });

  it('groups by category, largest total first', async () => {
    const result = await repository.aggregate(plan({ groupBy: ['category'] }));

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.key.category).toBe(categoryTransport);
    expect(result.rows[0]!.total.toDecimalString()).toBe('10000.00');
    expect(result.rows[1]!.key.category).toBe(categoryFood);
    expect(result.rows[1]!.total.toDecimalString()).toBe('8500.00');
  });

  it('derives average, min and max without a float', async () => {
    const result = await repository.aggregate(plan({ groupBy: ['category'] }));
    const food = result.rows.find((row) => row.key.category === categoryFood)!;

    expect(food.count).toBe(3);
    // 850000 / 3 = 283333.33... -> banker's rounding -> 283333 kobo
    expect(food.average!.minor).toBe(283_333n);
    expect(food.min!.toDecimalString()).toBe('1000.00');
    expect(food.max!.toDecimalString()).toBe('5000.00');
  });

  it('returns evidence ids so every number can be drilled into', async () => {
    const result = await repository.aggregate(plan({ groupBy: ['category'] }));

    expect(result.provenance).toHaveLength(4);
    expect(result.provenance).toContain(idFromSeed<'TransactionId'>(1_404));
  });
});

describe('timezone bucketing', () => {
  it('files a 00:30 Lagos transaction under the correct month, not the UTC one', async () => {
    const result = await repository.aggregate(plan({ groupBy: ['month'] }));

    const months = result.rows.map((row) => row.key.month?.slice(0, 7)).sort();

    // The 31 Aug 23:30Z ride is 1 Sep in Lagos, so it must form its own bucket.
    expect(months).toEqual(['2026-08', '2026-09']);

    const september = result.rows.find((row) => row.key.month?.startsWith('2026-09'))!;
    expect(september.total.toDecimalString()).toBe('10000.00');
  });

  it('keeps a 23:30 Lagos transaction on its own local day', async () => {
    const result = await repository.aggregate(plan({ groupBy: ['day'] }));

    const august7 = result.rows.find((row) => row.key.day?.startsWith('2026-08-07'))!;

    // Both the 14:23 and the 23:30 purchase are the same Lagos day.
    expect(august7.count).toBe(2);
    expect(august7.total.toDecimalString()).toBe('7500.00');
  });

  it('rolls a late-night transaction into the next local day, not the UTC one', async () => {
    // This is the assertion that actually discriminates: 31 Aug 23:30Z is 1 Sep in
    // Lagos. An earlier version of this test only checked 7 August, which is the
    // same day under both zones — so it passed while the timezone was being ignored.
    const days = (await repository.aggregate(plan({ groupBy: ['day'] }))).rows.map((row) =>
      row.key.day?.slice(0, 10),
    );

    expect(days).toContain('2026-09-01');
    expect(days).not.toContain('2026-08-31');
  });

  it('bucketing in UTC would give a different answer — proving the zone is applied', async () => {
    const utc = await repository.aggregate(plan({ groupBy: ['month'], timezone: 'UTC' }));

    expect(utc.rows).toHaveLength(1);
    expect(utc.rows[0]!.key.month?.slice(0, 7)).toBe('2026-08');
  });
});

describe('search', () => {
  it('escapes LIKE metacharacters instead of matching everything', async () => {
    const result = await repository.aggregate(
      plan({ filter: { ...plan().filter, search: '50%' } }),
    );

    // Without escaping, '%' would match all four debits.
    expect(result.rows[0]!.count).toBe(1);
    expect(result.rows[0]!.total.toDecimalString()).toBe('1000.00');
  });

  it('finds a merchant by substring', async () => {
    const result = await repository.aggregate(
      plan({ filter: { ...plan().filter, search: 'shoprite' } }),
    );

    expect(result.rows[0]!.count).toBe(1);
  });
});

describe('row-level security holds through the repository', () => {
  it("never returns another user's transactions", async () => {
    const result = await repository.aggregate(plan({ userId: userTwo }));

    // User two has exactly one debit, of 9,999.99 — and must not see user one's.
    expect(result.rows[0]!.total.toDecimalString()).toBe('9999.99');
    expect(result.rows[0]!.count).toBe(1);
  });

  it('scopes the transaction list per user', async () => {
    const forUserOne = await repository.listTransactions(plan({ limit: 50 }));
    const forUserTwo = await repository.listTransactions(plan({ userId: userTwo, limit: 50 }));

    expect(forUserOne.map((row) => row.description)).not.toContain('PRIVATE TO USER TWO');
    expect(forUserTwo.map((row) => row.description)).toEqual(['PRIVATE TO USER TWO']);
  });

  it('scopes balances per user', async () => {
    const forUserOne = await repository.getBalances(userOne);
    const forUserTwo = await repository.getBalances(userTwo);

    expect(forUserOne).toHaveLength(1);
    expect(forUserOne[0]!.label).toBe('Current');
    expect(forUserOne[0]!.balance.toDecimalString()).toBe('45200.15');
    expect(forUserOne[0]!.asOf).toBeInstanceOf(Date);

    expect(forUserTwo).toHaveLength(1);
    expect(forUserTwo[0]!.label).toBe('Savings');
    // No source has corroborated this balance yet, so it must not claim freshness.
    expect(forUserTwo[0]!.asOf).toBeNull();
  });
});

describe('transaction list', () => {
  it('returns newest first with money as exact values', async () => {
    const rows = await repository.listTransactions(plan({ limit: 50 }));

    expect(rows).toHaveLength(4);
    expect(rows[0]!.description).toBe('BOLT RIDE');
    expect(rows[0]!.amount.toDecimalString()).toBe('10000.00');
    expect(rows[0]!.direction).toBe('DEBIT');
  });

  it('honours the limit', async () => {
    expect(await repository.listTransactions(plan({ limit: 2 }))).toHaveLength(2);
  });
});

describe('plan validation is enforced at the boundary', () => {
  it('refuses an invalid plan rather than issuing a query', async () => {
    await expect(repository.aggregate(plan({ timezone: 'Mars/Olympus' }))).rejects.toThrow(
      /INVALID_TIMEZONE/,
    );
  });
});
