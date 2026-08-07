import { describe, expect, it } from 'vitest';
import { type CurrencyCode, Money, toId } from '@atlas/shared-kernel';
import type { LedgerGroupBy, LedgerMetric, LedgerQueryPlan } from '../../domain/ledger-query';
import { compileAggregate, compileTransactionList } from './aggregate-compiler';

/**
 * Guard test for risk R10 — the most dangerous defect available in this codebase.
 *
 * Reconciliation supersedes rather than deletes: an absorbed transaction keeps its row so
 * that insights, memories and past explanations citing its id still resolve (ADR-008). The
 * consequence is that any query which omits
 * `"supersededByTransactionId" IS NULL` counts the same money twice and **silently
 * overstates every total**. Silently is the problem — the number looks perfectly ordinary.
 *
 * So the exclusion is not left to review. This file enumerates the compiler's whole input
 * space — every group-by, every metric, every optional filter, and both entry points — and
 * asserts the predicate survives all of it. A future query that forgets fails the build
 * rather than lying about someone's spending.
 *
 * The enumeration is built from the exported union types, so widening `LedgerGroupBy` or
 * `LedgerMetric` without covering it here is a type error, not a silent coverage gap.
 */

const SUPERSESSION_PREDICATE = '"supersededByTransactionId" IS NULL';

const NGN = 'NGN' as CurrencyCode;
const USER = toId<'UserId'>('01KZ5SR0000000000000000001');

const ALL_GROUP_BY: readonly LedgerGroupBy[] = [
  'category',
  'merchant',
  'account',
  'direction',
  'day',
  'week',
  'month',
];

const ALL_METRICS: readonly LedgerMetric[] = ['total', 'count', 'average', 'min', 'max'];

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    userId: USER,
    filter: {
      currency: NGN,
      occurredFrom: new Date('2026-08-01T00:00:00.000Z'),
      occurredTo: new Date('2026-08-31T23:59:59.999Z'),
      ...overrides.filter,
    },
    metrics: ['total'],
    timezone: 'Africa/Lagos',
    ...overrides,
  };
}

/** Both entry points, so neither can drift away from the other. */
const COMPILERS = [
  { name: 'compileAggregate', compile: compileAggregate },
  { name: 'compileTransactionList', compile: compileTransactionList },
] as const;

describe('supersession exclusion (R10)', () => {
  describe.each(COMPILERS)('$name', ({ compile }) => {
    it('excludes superseded transactions on a bare plan', () => {
      expect(compile(plan()).sql).toContain(SUPERSESSION_PREDICATE);
    });

    it.each(ALL_GROUP_BY)('excludes superseded transactions when grouping by %s', (groupBy) => {
      expect(compile(plan({ groupBy: [groupBy] })).sql).toContain(SUPERSESSION_PREDICATE);
    });

    it.each(ALL_METRICS)('excludes superseded transactions for the %s metric', (metric) => {
      expect(compile(plan({ metrics: [metric] })).sql).toContain(SUPERSESSION_PREDICATE);
    });

    it('excludes superseded transactions when every group-by is combined', () => {
      expect(compile(plan({ groupBy: ALL_GROUP_BY, metrics: ALL_METRICS })).sql).toContain(
        SUPERSESSION_PREDICATE,
      );
    });

    it.each([
      ['accountIds', { accountIds: [toId<'AccountId'>('01KZACC0000000000000000001')] }],
      ['categoryIds', { categoryIds: [toId<'CategoryId'>('01KZCAT0000000000000000001')] }],
      ['merchantIds', { merchantIds: [toId<'MerchantId'>('01KZMER0000000000000000001')] }],
      ['direction', { direction: 'DEBIT' as const }],
      ['minAmount', { minAmount: Money.of(100n, NGN) }],
      ['maxAmount', { maxAmount: Money.of(100_000n, NGN) }],
      ['search', { search: 'shoprite' }],
    ])('excludes superseded transactions with the %s filter applied', (_label, filter) => {
      expect(compile(plan({ filter: { ...plan().filter, ...filter } })).sql).toContain(
        SUPERSESSION_PREDICATE,
      );
    });

    it('excludes superseded transactions with every filter applied at once', () => {
      const everything = plan({
        groupBy: ALL_GROUP_BY,
        metrics: ALL_METRICS,
        sort: { by: 'total', direction: 'desc' },
        limit: 50,
        filter: {
          ...plan().filter,
          accountIds: [toId<'AccountId'>('01KZACC0000000000000000001')],
          categoryIds: [toId<'CategoryId'>('01KZCAT0000000000000000001')],
          merchantIds: [toId<'MerchantId'>('01KZMER0000000000000000001')],
          direction: 'DEBIT',
          minAmount: Money.of(100n, NGN),
          maxAmount: Money.of(100_000n, NGN),
          search: 'shoprite',
        },
      });

      expect(compile(everything).sql).toContain(SUPERSESSION_PREDICATE);
    });

    /**
     * The predicate must be ANDed into the mandatory set, not left danglingly ORed or
     * placed where a later clause could shadow it. Asserting it appears before GROUP BY
     * pins it to the WHERE clause specifically.
     */
    it('places the exclusion inside the WHERE clause', () => {
      const { sql } = compile(plan({ groupBy: ['category'], metrics: ['total'] }));

      const whereAt = sql.indexOf('WHERE');
      const predicateAt = sql.indexOf(SUPERSESSION_PREDICATE);

      expect(whereAt).toBeGreaterThanOrEqual(0);
      expect(predicateAt).toBeGreaterThan(whereAt);
      expect(sql.slice(whereAt, predicateAt)).not.toContain('OR');
    });

    /** A bound parameter would mean a NULL comparison via `=`, which never matches. */
    it('compares with IS NULL rather than binding a parameter', () => {
      const { sql, params } = compile(plan());

      expect(sql).not.toContain('"supersededByTransactionId" =');
      expect(params).not.toContain(null);
    });
  });
});
