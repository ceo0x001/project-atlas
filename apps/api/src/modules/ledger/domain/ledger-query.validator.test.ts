import { idFromSeed, Money, type UserId } from '@atlas/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { LedgerQueryPlan } from './ledger-query';
import {
  DEFAULT_LIMIT,
  MAX_GROUP_BY_DIMENSIONS,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  type PlanDefect,
  validateQueryPlan,
} from './ledger-query.validator';

const userId = idFromSeed<'UserId'>(1) as UserId;

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    userId,
    timezone: 'Africa/Lagos',
    metrics: ['total'],
    filter: {
      currency: 'NGN',
      occurredFrom: new Date('2026-08-01T00:00:00Z'),
      occurredTo: new Date('2026-08-31T23:59:59Z'),
      ...overrides.filter,
    },
    ...overrides,
  };
}

function codes(candidate: LedgerQueryPlan): readonly PlanDefect['code'][] {
  const result = validateQueryPlan(candidate);
  return result.ok ? [] : result.error.map((defect) => defect.code);
}

describe('validateQueryPlan accepts sound plans', () => {
  it('passes a plain monthly total', () => {
    expect(validateQueryPlan(plan()).ok).toBe(true);
  });

  it('applies the default limit so an unbounded plan cannot reach the database', () => {
    const result = validateQueryPlan(plan());

    expect(result.ok && result.value.limit).toBe(DEFAULT_LIMIT);
  });

  it('preserves an explicit limit', () => {
    const result = validateQueryPlan(plan({ limit: 25 }));

    expect(result.ok && result.value.limit).toBe(25);
  });
});

describe('time window', () => {
  it('rejects a reversed range', () => {
    expect(
      codes(
        plan({
          filter: {
            currency: 'NGN',
            occurredFrom: new Date('2026-08-31T00:00:00Z'),
            occurredTo: new Date('2026-08-01T00:00:00Z'),
          },
        }),
      ),
    ).toContain('INVALID_RANGE');
  });

  it('rejects an invalid date rather than passing NaN to Postgres', () => {
    expect(
      codes(
        plan({
          filter: {
            currency: 'NGN',
            occurredFrom: new Date('not a date'),
            occurredTo: new Date('2026-08-01T00:00:00Z'),
          },
        }),
      ),
    ).toContain('INVALID_RANGE');
  });

  it('rejects a range that is a table scan dressed as a question', () => {
    const from = new Date('1990-01-01T00:00:00Z');
    const to = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000);

    expect(
      codes(plan({ filter: { currency: 'NGN', occurredFrom: from, occurredTo: to } })),
    ).toContain('RANGE_TOO_WIDE');
  });
});

describe('currency and timezone', () => {
  it('rejects an unsupported currency', () => {
    expect(codes(plan({ filter: { ...plan().filter, currency: 'EUR' as 'NGN' } }))).toContain(
      'INVALID_CURRENCY',
    );
  });

  it('rejects an unknown timezone before Postgres has to', () => {
    expect(codes(plan({ timezone: 'Mars/Olympus' }))).toContain('INVALID_TIMEZONE');
  });

  it('accepts a real IANA zone', () => {
    expect(validateQueryPlan(plan({ timezone: 'America/New_York' })).ok).toBe(true);
  });
});

describe('metrics, grouping and sorting', () => {
  it('rejects a plan that asks for nothing', () => {
    expect(codes(plan({ metrics: [] }))).toContain('INVALID_METRIC');
  });

  it('rejects an unknown metric', () => {
    expect(codes(plan({ metrics: ['median' as 'total'] }))).toContain('INVALID_METRIC');
  });

  it('rejects an unknown group-by dimension', () => {
    expect(codes(plan({ groupBy: ['hour' as 'day'] }))).toContain('INVALID_GROUP_BY');
  });

  it('rejects a duplicate dimension', () => {
    expect(codes(plan({ groupBy: ['category', 'category'] }))).toContain('INVALID_GROUP_BY');
  });

  it('rejects more dimensions than a result can readably carry', () => {
    const tooMany = Array.from(
      { length: MAX_GROUP_BY_DIMENSIONS + 1 },
      (_v, i) => (['category', 'merchant', 'account', 'day'] as const)[i]!,
    );

    expect(codes(plan({ groupBy: tooMany }))).toContain('INVALID_GROUP_BY');
  });

  it('rejects sorting by a metric the plan did not request', () => {
    expect(codes(plan({ metrics: ['count'], sort: { by: 'total', direction: 'desc' } }))).toContain(
      'INVALID_SORT',
    );
  });

  it('accepts sorting by a requested metric', () => {
    expect(
      validateQueryPlan(plan({ metrics: ['total'], sort: { by: 'total', direction: 'asc' } })).ok,
    ).toBe(true);
  });
});

describe('limits and identifiers', () => {
  it.each([0, -1, 1.5, MAX_LIMIT + 1])('rejects limit %s', (limit) => {
    expect(codes(plan({ limit }))).toContain('INVALID_LIMIT');
  });

  it('rejects an identifier that is not a ULID', () => {
    expect(
      codes(plan({ filter: { ...plan().filter, accountIds: ["'; DROP TABLE" as never] } })),
    ).toContain('INVALID_ID');
  });

  it('accepts genuine ULIDs', () => {
    expect(
      validateQueryPlan(
        plan({ filter: { ...plan().filter, accountIds: [idFromSeed<'AccountId'>(1)] } }),
      ).ok,
    ).toBe(true);
  });

  it('rejects an oversized search term', () => {
    expect(codes(plan({ filter: { ...plan().filter, search: 'x'.repeat(201) } }))).toContain(
      'INVALID_SEARCH',
    );
  });
});

describe('amount bounds', () => {
  it('rejects a minimum above the maximum', () => {
    expect(
      codes(
        plan({
          filter: {
            ...plan().filter,
            minAmount: Money.of(1000n, 'NGN'),
            maxAmount: Money.of(100n, 'NGN'),
          },
        }),
      ),
    ).toContain('INVALID_AMOUNT_BOUNDS');
  });

  it('rejects bounds in a different currency from the filter', () => {
    expect(
      codes(
        plan({
          filter: {
            ...plan().filter,
            minAmount: Money.of(100n, 'USD'),
            maxAmount: Money.of(1000n, 'USD'),
          },
        }),
      ),
    ).toContain('INVALID_AMOUNT_BOUNDS');
  });
});

describe('defect reporting', () => {
  it('returns every problem at once, for a single corrective retry', () => {
    const result = validateQueryPlan(plan({ metrics: [], timezone: 'Mars/Olympus', limit: -5 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.map((defect) => defect.code).sort()).toEqual([
      'INVALID_LIMIT',
      'INVALID_METRIC',
      'INVALID_TIMEZONE',
    ]);
  });
});
