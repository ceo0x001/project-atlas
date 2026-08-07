import { idFromSeed, Money, type UserId } from '@atlas/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { LedgerQueryPlan } from '../../domain/ledger-query';
import {
  compileAggregate,
  compileTransactionList,
  escapeLikePattern,
  EVIDENCE_SAMPLE_SIZE,
} from './aggregate-compiler';

const userId = idFromSeed<'UserId'>(1) as UserId;

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    userId,
    timezone: 'Africa/Lagos',
    metrics: ['total', 'count'],
    filter: {
      currency: 'NGN',
      occurredFrom: new Date('2026-08-01T00:00:00Z'),
      occurredTo: new Date('2026-08-31T23:59:59Z'),
      ...overrides.filter,
    },
    ...overrides,
  };
}

describe('injection safety', () => {
  const hostile = "'; DROP TABLE transactions; --";

  it('never interpolates a free-text search term into SQL', () => {
    const compiled = compileAggregate(plan({ filter: { ...plan().filter, search: hostile } }));

    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.params).toContainEqual(`%${escapeLikePattern(hostile)}%`);
  });

  it('never interpolates the timezone', () => {
    const compiled = compileAggregate(plan({ timezone: hostile, groupBy: ['day'] }));

    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.params).toContain(hostile);
  });

  it('binds the user id rather than embedding it', () => {
    const compiled = compileAggregate(plan());

    expect(compiled.sql).not.toContain(userId);
    expect(compiled.params).toContain(userId);
  });

  it('does not bind a timezone no dimension uses', () => {
    // A dead parameter is confusing at best and a driver arity mismatch at worst.
    expect(compileAggregate(plan({ groupBy: ['category'] })).params).not.toContain('Africa/Lagos');
    expect(compileAggregate(plan({ groupBy: ['month'] })).params).toContain('Africa/Lagos');
  });

  it('emits placeholders numbered contiguously from $1', () => {
    const compiled = compileAggregate(
      plan({
        groupBy: ['category'],
        filter: {
          ...plan().filter,
          search: 'fuel',
          direction: 'DEBIT',
          minAmount: Money.of(100n, 'NGN'),
        },
      }),
    );

    const placeholders = [...compiled.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    const expected = Array.from({ length: compiled.params.length }, (_value, index) => index + 1);

    expect([...new Set(placeholders)].sort((a, b) => a - b)).toEqual(expected);
  });
});

describe('LIKE escaping', () => {
  it.each([
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['plain', 'plain'],
  ])('escapes %s to %s', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  it('stops a wildcard in user text from matching every transaction', () => {
    const compiled = compileAggregate(plan({ filter: { ...plan().filter, search: '%' } }));

    expect(compiled.params).toContainEqual('%\\%%');
    expect(compiled.sql).toContain("ESCAPE '\\'");
  });
});

describe('money handling', () => {
  it('casts every monetary aggregate to text, never a float', () => {
    const compiled = compileAggregate(plan());

    expect(compiled.sql).toContain('SUM(t."amountMinor"), 0)::text');
    expect(compiled.sql).toContain('MIN(t."amountMinor")::text');
    expect(compiled.sql).toContain('MAX(t."amountMinor")::text');
  });

  it('never asks Postgres for AVG — averages are derived exactly in Money', () => {
    const compiled = compileAggregate(plan({ metrics: ['average'], groupBy: ['category'] }));

    expect(compiled.sql).not.toMatch(/\bAVG\s*\(/i);
  });

  it('binds amount bounds as strings so a bigint survives the driver', () => {
    const compiled = compileAggregate(
      plan({
        filter: {
          ...plan().filter,
          minAmount: Money.of(9_007_199_254_740_993n, 'NGN'),
        },
      }),
    );

    expect(compiled.params).toContain('9007199254740993');
  });
});

describe('grouping', () => {
  it('buckets time in the requested zone, not UTC', () => {
    const compiled = compileAggregate(plan({ groupBy: ['day'] }));

    expect(compiled.sql).toContain(`date_trunc('day', t."occurredAt" AT TIME ZONE $1)`);
  });

  it.each([
    ['category', 't."categoryId"'],
    ['merchant', 't."merchantId"'],
    ['account', 't."accountId"'],
    ['direction', 't.direction::text'],
  ] as const)('maps %s to an allowlisted expression', (dimension, expression) => {
    expect(compileAggregate(plan({ groupBy: [dimension] })).sql).toContain(expression);
  });

  it('groups by ordinal, which cannot collide with a column name', () => {
    const compiled = compileAggregate(plan({ groupBy: ['category', 'month'] }));

    expect(compiled.sql).toContain('GROUP BY 1, 2');
  });

  it('omits GROUP BY and top-level ORDER BY for a single-row aggregate', () => {
    const compiled = compileAggregate(plan());

    expect(compiled.sql).not.toContain('GROUP BY');
    // Anchored: array_agg carries its own inner ORDER BY, which is not a sort of
    // the result set.
    expect(compiled.sql).not.toMatch(/^ORDER BY/m);
  });

  it('attaches a bounded sample of evidence ids to every row', () => {
    const compiled = compileAggregate(plan({ groupBy: ['category'] }));

    expect(compiled.sql).toContain(`[1:${EVIDENCE_SAMPLE_SIZE}] AS evidence`);
  });
});

describe('ordering', () => {
  it('sorts on the numeric aggregate, not the text-cast alias', () => {
    // Ordering the ::text alias would rank '9' above '1000'.
    const compiled = compileAggregate(
      plan({ groupBy: ['category'], sort: { by: 'total', direction: 'desc' } }),
    );

    expect(compiled.sql).toContain('ORDER BY SUM(t."amountMinor") DESC');
    expect(compiled.sql).not.toMatch(/ORDER BY\s+total/);
  });

  it('derives an average ordering from SUM and COUNT', () => {
    const compiled = compileAggregate(
      plan({
        metrics: ['average'],
        groupBy: ['category'],
        sort: { by: 'average', direction: 'desc' },
      }),
    );

    expect(compiled.sql).toContain('SUM(t."amountMinor")::numeric / NULLIF(COUNT(*), 0) DESC');
  });

  it('defaults to largest-total-first, the useful answer to "what did I spend on"', () => {
    expect(compileAggregate(plan({ groupBy: ['category'] })).sql).toContain(
      'ORDER BY SUM(t."amountMinor") DESC',
    );
  });

  it('breaks ties on the group key so results are stable between runs', () => {
    expect(compileAggregate(plan({ groupBy: ['category'] })).sql).toContain('NULLS LAST, 1');
  });

  it('honours an ascending sort', () => {
    const compiled = compileAggregate(
      plan({ groupBy: ['category'], sort: { by: 'count', direction: 'asc' } }),
    );

    expect(compiled.sql).toContain('ORDER BY COUNT(*) ASC');
  });
});

describe('filters', () => {
  it('always scopes to the user and to settled transactions', () => {
    const compiled = compileAggregate(plan());

    expect(compiled.sql).toContain('t."userId" = $');
    expect(compiled.sql).toContain('t.status = $');
    expect(compiled.params).toContain('POSTED');
  });

  it('omits optional predicates that were not requested', () => {
    const compiled = compileAggregate(plan());

    expect(compiled.sql).not.toContain('ILIKE');
    expect(compiled.sql).not.toContain('t."categoryId" = ANY');
  });

  it('passes id lists as a bound array rather than a rendered IN clause', () => {
    const accountIds = [idFromSeed<'AccountId'>(1), idFromSeed<'AccountId'>(2)];
    const compiled = compileAggregate(plan({ filter: { ...plan().filter, accountIds } }));

    expect(compiled.sql).toContain('t."accountId" = ANY($');
    expect(compiled.params).toContainEqual([...accountIds]);
  });
});

describe('compileTransactionList', () => {
  it('returns the columns the canvas renders from', () => {
    const compiled = compileTransactionList(plan());

    expect(compiled.sql).toContain('t."amountMinor"::text');
    expect(compiled.sql).toContain('t."balanceAfterMinor"::text');
  });

  it('orders newest first with a deterministic tiebreaker', () => {
    expect(compileTransactionList(plan()).sql).toContain('ORDER BY t."occurredAt" DESC, t.id DESC');
  });

  it('shares predicate construction with the aggregate query', () => {
    const filter = { ...plan().filter, search: 'fuel' };

    expect(compileTransactionList(plan({ filter })).params).toContainEqual('%fuel%');
  });

  it('always applies a limit', () => {
    const compiled = compileTransactionList(plan({ limit: 25 }));

    expect(compiled.sql).toContain('LIMIT $');
    expect(compiled.params).toContain(25);
  });
});
