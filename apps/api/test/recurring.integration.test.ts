import { PrismaClient } from '@prisma/client';
import { idFromSeed, type CurrencyCode, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { RecurringDetectionService } from '../src/modules/intelligence';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * Recurring detection against real rows.
 *
 * The algorithm itself is covered exhaustively by unit tests; what these prove is the part that
 * touches the database — that a stored series is refreshed rather than duplicated, that a user's
 * dismissal survives re-detection, and that the projection includes an **overdue** bill.
 *
 * That last one was a real defect found by running it: an obligation four days late vanished from
 * the projection entirely, which reported "not short" while ignoring money that still had to go out.
 *
 * Requires `pnpm infra:up`.
 */

const NGN = 'NGN' as CurrencyCode;

const userId = idFromSeed<'UserId'>(19_000) as UserId;
const accountId = idFromSeed<'AccountId'>(19_100);

const env = parseEnv();

const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const service = new RecurringDetectionService(new TenantScope(app));

/** 7 August 2026, matching the seeded history below. */
const NOW = new Date('2026-08-07T12:00:00Z');

let seed = 0;

async function transaction(spec: {
  isoDate: string;
  amountMinor: bigint;
  description: string;
  direction?: 'DEBIT' | 'CREDIT';
}): Promise<void> {
  seed += 1;

  await owner.transaction.create({
    data: {
      id: idFromSeed<'TransactionId'>(19_200 + seed),
      userId,
      accountId,
      amountMinor: spec.amountMinor,
      currency: 'NGN',
      direction: spec.direction ?? 'DEBIT',
      occurredAt: new Date(`${spec.isoDate}T09:00:00Z`),
      description: spec.description,
      status: 'POSTED',
    },
  });
}

/** DSTV on the 3rd — last seen in July, so on 7 August it is four days overdue. */
async function seedOverdueBill(): Promise<void> {
  for (const month of ['04', '05', '06', '07']) {
    await transaction({
      isoDate: `2026-${month}-03`,
      amountMinor: 2_450_000n,
      description: `DSTV SUBSCRIPTION ${month}00`,
    });
  }
}

async function seedSalary(): Promise<void> {
  for (const month of ['05', '06', '07']) {
    await transaction({
      isoDate: `2026-${month}-28`,
      amountMinor: 45_000_000n,
      description: 'SALARY PAYMENT',
      direction: 'CREDIT',
    });
  }
}

async function wipe(): Promise<void> {
  await owner.recurringSeries.deleteMany({ where: { userId } });
  await owner.transaction.deleteMany({ where: { userId } });
}

beforeAll(async () => {
  await wipe();
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });

  await owner.user.create({
    data: { id: userId, phoneE164: '+2348000019000', timezone: 'Africa/Lagos' },
  });
  await owner.account.create({
    data: {
      id: accountId,
      userId,
      label: 'Main',
      type: 'CURRENT',
      currency: 'NGN',
      currentBalanceMinor: 3_000_000n,
      balanceAsOf: NOW,
    },
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

describe('detecting and storing series', () => {
  it('stores what it detects', async () => {
    await seedOverdueBill();

    const detected = await service.refresh(userId, NOW);
    expect(detected).toHaveLength(1);

    const stored = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });
    expect(stored.kind).toBe('BILL');
    expect(stored.cadence).toBe('MONTHLY');
    expect(stored.expectedAmountMinor).toBe(2_450_000n);
    expect(stored.occurrences).toBe(4);
  });

  /**
   * The reason a stable detection key exists. Re-running must update the row in place, or every
   * refresh would leave another copy of the same bill behind.
   */
  it('refreshes in place rather than duplicating on re-run', async () => {
    await seedOverdueBill();

    await service.refresh(userId, NOW);
    await service.refresh(userId, NOW);
    await service.refresh(userId, NOW);

    expect(await owner.recurringSeries.count({ where: { userId } })).toBe(1);
  });

  /** Derived figures must never be stale: a new payment has to move the expectation. */
  it('updates the derived figures when a new payment arrives', async () => {
    await seedOverdueBill();
    await service.refresh(userId, NOW);

    await transaction({
      isoDate: '2026-08-03',
      amountMinor: 2_450_000n,
      description: 'DSTV SUBSCRIPTION 0800',
    });
    await service.refresh(userId, NOW);

    const stored = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });
    expect(stored.occurrences).toBe(5);
    expect(stored.nextExpectedAt?.toISOString().slice(0, 10)).toBe('2026-09-03');
  });

  it('deactivates a series it no longer sees, rather than deleting it', async () => {
    await seedOverdueBill();
    await service.refresh(userId, NOW);

    await owner.transaction.deleteMany({ where: { userId } });
    await service.refresh(userId, NOW);

    const stored = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });
    // Kept: a bill that stopped is a fact, and the row may carry a name the user gave it.
    expect(stored.isActive).toBe(false);
  });
});

describe('a dismissal is the user’s, and detection must not overrule it', () => {
  it('never resurrects a dismissed series', async () => {
    await seedOverdueBill();
    await service.refresh(userId, NOW);

    const stored = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });
    expect(await service.dismiss(userId, stored.id)).toBe(true);

    // The evidence is all still there, so detection will find the pattern again — and must
    // still not report it. Being asked twice about the same wrong guess is how trust is lost.
    const detected = await service.refresh(userId, NOW);
    expect(detected).toEqual([]);

    const after = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });
    expect(after.dismissedAt).not.toBeNull();
    expect(after.isActive).toBe(false);
  });

  it('reports a second dismissal as already done', async () => {
    await seedOverdueBill();
    await service.refresh(userId, NOW);
    const stored = await owner.recurringSeries.findFirstOrThrow({ where: { userId } });

    await service.dismiss(userId, stored.id);

    expect(await service.dismiss(userId, stored.id)).toBe(false);
  });
});

describe('projecting what is coming', () => {
  /**
   * The defect a live run exposed. Filtering obligations on `>= now` dropped a bill that was four
   * days late, so the projection reported "not short" while ignoring money that still had to go out
   * — and an overdue bill is the most useful thing this can say.
   */
  it('includes an overdue bill and counts it against the balance', async () => {
    await seedOverdueBill();

    const projection = await service.project(userId, NGN, 30, NOW);

    const overdue = projection.obligations.filter((obligation) => obligation.overdue);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.daysAway).toBeLessThan(0);
    expect(projection.outgoing.minor).toBe(2_450_000n);
  });

  it('counts expected income as well as outgoings', async () => {
    await seedOverdueBill();
    await seedSalary();

    const projection = await service.project(userId, NGN, 30, NOW);

    expect(projection.incoming.minor).toBe(45_000_000n);
    expect(projection.outgoing.minor).toBe(2_450_000n);
    // 30,000 balance + 450,000 salary − 24,500 overdue bill.
    expect(projection.projected.minor).toBe(45_550_000n);
    expect(projection.short).toBe(false);
  });

  it('reports a shortfall when commitments exceed the balance and income', async () => {
    await seedOverdueBill();

    await owner.account.update({
      where: { id: accountId },
      data: { currentBalanceMinor: 100_000n },
    });

    const projection = await service.project(userId, NGN, 30, NOW);

    // 1,000 balance against a 24,500 bill.
    expect(projection.short).toBe(true);
    expect(projection.projected.isNegative).toBe(true);
  });

  /**
   * `nextExpectedAt` is derived from the last sighting, so a cancelled subscription would otherwise
   * sit in the past and be reported as overdue for ever.
   */
  it('drops an obligation later than its own cycle as stopped, not overdue', async () => {
    for (const month of ['01', '02', '03']) {
      await transaction({
        isoDate: `2026-${month}-03`,
        amountMinor: 900_000n,
        description: `OLD SUBSCRIPTION ${month}`,
      });
    }

    const projection = await service.project(userId, NGN, 30, NOW);

    // Last seen in March; on 7 August that is far more than one monthly cycle late.
    expect(projection.obligations).toEqual([]);
  });

  /** A habit is a choice, not a commitment — counting it would overstate what is unavoidable. */
  it('excludes habits from the commitment arithmetic', async () => {
    for (const [date, amount] of [
      ['2026-08-01', 800_000n],
      ['2026-08-08', 1_500_000n],
      ['2026-08-15', 600_000n],
      ['2026-08-22', 1_200_000n],
    ] as const) {
      await transaction({ isoDate: date, amountMinor: amount, description: 'FUEL STATION' });
    }

    const projection = await service.project(userId, NGN, 30, NOW);

    expect(projection.obligations.filter((o) => o.kind === 'HABIT')).toEqual([]);
    expect(projection.outgoing.minor).toBe(0n);
  });

  it('does not mix currencies into one projection', async () => {
    await seedOverdueBill();

    const usd = await service.project(userId, 'USD' as CurrencyCode, 30, NOW);

    expect(usd.obligations).toEqual([]);
    expect(usd.balance.minor).toBe(0n);
  });
});
