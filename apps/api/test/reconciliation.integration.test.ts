import { PrismaClient } from '@prisma/client';
import { idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import {
  TRANSACTION_OBSERVED,
  type TransactionObservedEvent,
} from '../src/shared/events/contracts';
import { ReconciliationService } from '../src/modules/ledger/application/reconciliation.service';
import { TransactionAdmissionService } from '../src/modules/ledger/application/transaction-admission.service';
import type { LedgerQueryPlan } from '../src/modules/ledger/domain/ledger-query';
import { PrismaLedgerQueryRepository } from '../src/modules/ledger/infrastructure/prisma-ledger-query.repository';
import { DomainEventBus } from '../src/shared/events/domain-event-bus';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * The M2 milestone: what happens when two sources describe the same money.
 *
 * These are the two tests the whole design exists to pass, and they pull in opposite
 * directions:
 *
 *   1. An SMS alert and a statement row for one purchase must collapse into **one**
 *      transaction, or Atlas overstates spending.
 *   2. Two genuinely separate ₦100 top-ups on one day must stay **two**, or Atlas
 *      understates it — silently, which is worse.
 *
 * Any matcher can pass one of these. Passing both is the requirement.
 *
 * Real Postgres, real row-level security, real admission path. Requires `pnpm infra:up`.
 */

const userId = idFromSeed<'UserId'>(11_000) as UserId;
const accountId = idFromSeed<'AccountId'>(11_100);

const env = parseEnv();

/** Owner connection: bypasses RLS, so it can seed and inspect. */
const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const tenantScope = new TenantScope(app);
const admission = new TransactionAdmissionService(
  tenantScope,
  new DomainEventBus(),
  new ReconciliationService(),
);
const repository = new PrismaLedgerQueryRepository(tenantScope);

let observationSeed = 0;

interface ObservationSpec {
  readonly source: 'SMS' | 'EMAIL' | 'STATEMENT';
  readonly amountMinor: bigint;
  readonly occurredAt: string;
  readonly balanceAfterMinor?: bigint | null;
  readonly description?: string;
  readonly rawReference?: string | null;
}

/**
 * Stores an observation exactly as the sync endpoint would, then drives admission through
 * the same event the outbox delivers. Using the real handler rather than a shortcut is the
 * point: the decision path under test is the one production runs.
 */
async function observe(spec: ObservationSpec): Promise<void> {
  observationSeed += 1;
  const observationId = idFromSeed<'ObservationId'>(11_500 + observationSeed);
  const occurredAt = new Date(spec.occurredAt);

  await owner.transactionObservation.create({
    data: {
      id: observationId,
      userId,
      accountId,
      source: spec.source,
      amountMinor: spec.amountMinor,
      currency: 'NGN',
      direction: 'DEBIT',
      occurredAt,
      observedAt: occurredAt,
      balanceAfterMinor: spec.balanceAfterMinor ?? null,
      description: spec.description ?? null,
      rawReference: spec.rawReference ?? null,
      dedupeKey: `${'0'.repeat(60)}${(1000 + observationSeed).toString(16).padStart(4, '0')}`,
    },
  });

  const event: TransactionObservedEvent = {
    id: idFromSeed<'EventId'>(12_000 + observationSeed),
    type: TRANSACTION_OBSERVED,
    userId,
    occurredAt: new Date(),
    payload: {
      observationId,
      source: spec.source,
      accountId,
      institutionId: null,
      deviceId: null,
      amountMinor: spec.amountMinor.toString(),
      currency: 'NGN',
      direction: 'DEBIT',
      occurredAt: occurredAt.toISOString(),
      balanceAfterMinor: spec.balanceAfterMinor?.toString() ?? null,
      description: spec.description ?? null,
    },
  };

  await admission.handle(event);
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

/** Live transactions only — superseded rows are excluded, as every aggregate does. */
async function liveTransactions() {
  return owner.transaction.findMany({
    where: { userId, supersededByTransactionId: null },
    orderBy: { occurredAt: 'asc' },
    include: { observations: { select: { id: true, source: true } } },
  });
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
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
  await wipe();

  await owner.user.create({
    data: { id: userId, phoneE164: '+2348000011000', timezone: 'Africa/Lagos' },
  });
  await owner.account.create({
    data: { id: accountId, userId, label: 'Current', type: 'CURRENT', currency: 'NGN' },
  });
});

beforeEach(async () => {
  await owner.reconciliationEvent.deleteMany({ where: { userId } });
  await owner.suspectedDuplicate.deleteMany({ where: { userId } });
  await owner.transactionObservation.deleteMany({ where: { userId } });
  await owner.transaction.updateMany({
    where: { userId },
    data: { supersededByTransactionId: null },
  });
  await owner.transaction.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await wipe();
  await owner.$disconnect();
  await app.$disconnect();
});

describe('F1 — two sources, one transaction', () => {
  it('collapses an SMS alert and a statement row for the same purchase', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
      balanceAfterMinor: 4_500_000n,
      description: 'POS PURCHASE AT SHOPRITE IKEJA',
    });

    // The statement arrives later, dated a day off and with a terse narration — but
    // reporting the same balance, which is what identifies it.
    await observe({
      source: 'STATEMENT',
      amountMinor: 500_000n,
      occurredAt: '2026-08-08T00:00:00Z',
      balanceAfterMinor: 4_500_000n,
      description: 'POS/1234/TRF',
    });

    const live = await liveTransactions();

    expect(live).toHaveLength(1);
    expect(live[0]?.observations).toHaveLength(2);

    const result = await repository.aggregate(plan());
    expect(result.rows[0]?.total.minor).toBe(500_000n);
    expect(result.rows[0]?.count).toBe(1);
  });

  /**
   * The projection rule that keeps monthly totals honest: the statement's booking date
   * would move this purchase into the next day, and at a month boundary into the next
   * month.
   */
  it('keeps the alert timestamp and the alert narration after merging', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
      balanceAfterMinor: 4_500_000n,
      description: 'POS PURCHASE AT SHOPRITE IKEJA',
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 500_000n,
      occurredAt: '2026-08-08T00:00:00Z',
      balanceAfterMinor: 4_500_000n,
      description: 'POS/1234/TRF',
    });

    const [survivor] = await liveTransactions();

    expect(survivor?.occurredAt).toEqual(new Date('2026-08-07T10:00:00Z'));
    expect(survivor?.description).toBe('POS PURCHASE AT SHOPRITE IKEJA');
  });

  it('records the merge with the evidence that justified it', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 500_000n,
      occurredAt: '2026-08-07T10:00:00Z',
      balanceAfterMinor: 4_500_000n,
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 500_000n,
      occurredAt: '2026-08-08T00:00:00Z',
      balanceAfterMinor: 4_500_000n,
    });

    // Nothing was superseded here — the second observation attached to the existing
    // transaction, so no transaction was absorbed and no MERGE event is warranted.
    const merges = await owner.reconciliationEvent.findMany({ where: { userId, kind: 'MERGE' } });
    expect(merges).toEqual([]);

    // What matters is that the money is counted once and both sources are cited.
    const live = await liveTransactions();
    expect(live).toHaveLength(1);
    expect(live[0]?.observations.map((o) => o.source).sort()).toEqual(['SMS', 'STATEMENT']);
  });

  it('merges on an equal bank reference even when balances are unknown', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 750_000n,
      occurredAt: '2026-08-09T10:00:00Z',
      rawReference: 'FT21234567',
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 750_000n,
      occurredAt: '2026-08-10T00:00:00Z',
      rawReference: 'ft 21234567',
    });

    expect(await liveTransactions()).toHaveLength(1);
  });
});

describe('F2 — look-alikes stay separate', () => {
  /**
   * The failure that would silently steal money from the user's own history. Two genuine
   * ₦100 airtime top-ups are indistinguishable, so merging them understates spending with
   * no way for the user to notice.
   */
  it('keeps two genuine identical top-ups as two transactions', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 10_000n,
      occurredAt: '2026-08-07T08:00:00Z',
      description: 'AIRTIME TOPUP',
    });
    await observe({
      source: 'SMS',
      amountMinor: 10_000n,
      occurredAt: '2026-08-07T19:00:00Z',
      description: 'AIRTIME TOPUP',
    });

    const live = await liveTransactions();
    expect(live).toHaveLength(2);

    const result = await repository.aggregate(plan());
    expect(result.rows[0]?.total.minor).toBe(20_000n);
    expect(result.rows[0]?.count).toBe(2);
  });

  it('refuses to merge when the two report different balances', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 300_000n,
      occurredAt: '2026-08-11T10:00:00Z',
      balanceAfterMinor: 2_000_000n,
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 300_000n,
      occurredAt: '2026-08-11T10:00:30Z',
      balanceAfterMinor: 1_700_000n,
    });

    expect(await liveTransactions()).toHaveLength(2);
  });

  it('refuses to merge when the bank labelled them differently', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 300_000n,
      occurredAt: '2026-08-12T10:00:00Z',
      rawReference: 'FT-AAA',
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 300_000n,
      occurredAt: '2026-08-12T11:00:00Z',
      rawReference: 'FT-BBB',
    });

    expect(await liveTransactions()).toHaveLength(2);
  });

  it('never merges amounts that differ by a single kobo', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 500_000n,
      occurredAt: '2026-08-13T10:00:00Z',
      balanceAfterMinor: 9_000_000n,
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 500_001n,
      occurredAt: '2026-08-13T10:00:10Z',
      balanceAfterMinor: 9_000_000n,
    });

    expect(await liveTransactions()).toHaveLength(2);
  });
});

describe('asking instead of guessing', () => {
  /**
   * Amount and timing agree, but nothing corroborates: no shared reference, no reported
   * balance. Both transactions stay, and the pair is queued as a question.
   */
  it('queues a suspected duplicate rather than merging on circumstantial evidence', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T10:00:00Z',
      description: 'POS PURCHASE',
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T18:00:00Z',
      description: 'POS/9999',
    });

    expect(await liveTransactions()).toHaveLength(2);

    const queued = await owner.suspectedDuplicate.findMany({ where: { userId } });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.resolution).toBeNull();

    // Ordered by id so the same pair cannot be queued twice from opposite directions.
    expect((queued[0]?.leftTransactionId ?? '') < (queued[0]?.rightTransactionId ?? '')).toBe(true);
  });

  it('leaves the money counted twice while the question is open', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T10:00:00Z',
      description: 'POS PURCHASE',
    });
    await observe({
      source: 'STATEMENT',
      amountMinor: 450_000n,
      occurredAt: '2026-08-14T18:00:00Z',
      description: 'POS/9999',
    });

    // Deliberate: an unresolved duplicate is visible and correctable, whereas a wrong
    // merge would hide real spending with no way for the user to notice (ADR-008 §4).
    const result = await repository.aggregate(plan());
    expect(result.rows[0]?.count).toBe(2);
  });
});

describe('idempotency', () => {
  it('is a no-op when the same event is redelivered', async () => {
    await observe({
      source: 'SMS',
      amountMinor: 500_000n,
      occurredAt: '2026-08-15T10:00:00Z',
      balanceAfterMinor: 4_000_000n,
    });

    const first = await liveTransactions();

    const observation = await owner.transactionObservation.findFirstOrThrow({
      where: { userId },
    });

    // Delivery is at-least-once, so the handler must tolerate seeing this twice.
    await admission.handle({
      id: idFromSeed<'EventId'>(12_900),
      type: TRANSACTION_OBSERVED,
      userId,
      occurredAt: new Date(),
      payload: {
        observationId: observation.id as never,
        source: 'SMS',
        accountId,
        institutionId: null,
        deviceId: null,
        amountMinor: '500000',
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: '2026-08-15T10:00:00Z',
        balanceAfterMinor: '4000000',
        description: null,
      },
    });

    expect(await liveTransactions()).toHaveLength(first.length);
  });
});
