import { describe, expect, it } from 'vitest';
import { type CurrencyCode, toId } from '@atlas/shared-kernel';
import type { ObservationFacts, ObservationSource } from './observation-facts';
import {
  type ObservationSet,
  projectTransaction,
  UNLABELLED_DESCRIPTION,
} from './transaction-projection';

const NGN = 'NGN' as CurrencyCode;

function observation(
  overrides: Partial<ObservationFacts> & { source: ObservationSource },
): ObservationFacts {
  return {
    id: toId<'ObservationId'>('01KZ0BS0000000000000000001'),
    amountMinor: 500_000n,
    currency: NGN,
    direction: 'DEBIT',
    occurredAt: new Date('2026-08-07T10:00:00.000Z'),
    balanceAfterMinor: null,
    description: null,
    rawReference: null,
    observedAt: new Date('2026-08-07T10:00:05.000Z'),
    ...overrides,
  };
}

function withId(id: string, facts: ObservationFacts): ObservationFacts {
  return { ...facts, id: toId<'ObservationId'>(id) };
}

describe('projectTransaction', () => {
  it('projects a single observation unchanged', () => {
    const only = observation({ source: 'SMS', description: 'POS PURCHASE AT SHOPRITE' });

    const projected = projectTransaction([only]);

    expect(projected.amountMinor).toBe(500_000n);
    expect(projected.description).toBe('POS PURCHASE AT SHOPRITE');
    expect(projected.conflicts).toEqual([]);
    expect(projected.sourcedFrom.amount).toBe(only.id);
  });

  it('prefers the statement amount over the alert amount', () => {
    const set: ObservationSet = [
      withId('01KZ0BS0000000000000000001', observation({ source: 'SMS', amountMinor: 500_000n })),
      withId(
        '01KZ0BS0000000000000000002',
        observation({ source: 'STATEMENT', amountMinor: 499_900n }),
      ),
    ];

    const projected = projectTransaction(set);

    expect(projected.amountMinor).toBe(499_900n);
  });

  it('lets a user correction outrank the statement', () => {
    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({ source: 'STATEMENT', amountMinor: 499_900n }),
      ),
      withId(
        '01KZ0BS0000000000000000002',
        observation({ source: 'USER_STATED', amountMinor: 450_000n }),
      ),
    ];

    expect(projectTransaction(set).amountMinor).toBe(450_000n);
  });

  /**
   * The rule that keeps month-boundary totals correct: a purchase alerted on 31 August
   * whose statement books on 2 September must stay in August.
   */
  it('prefers the alert timestamp over the statement booking date', () => {
    const alerted = new Date('2026-08-31T21:40:00.000Z');
    const booked = new Date('2026-09-02T00:00:00.000Z');

    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({ source: 'STATEMENT', occurredAt: booked }),
      ),
      withId('01KZ0BS0000000000000000002', observation({ source: 'SMS', occurredAt: alerted })),
    ];

    const projected = projectTransaction(set);

    expect(projected.occurredAt).toEqual(alerted);
    // ...while the statement still wins on amount. Precedence is per field, not global.
    expect(projected.sourcedFrom.amount).not.toBe(projected.sourcedFrom.occurredAt);
  });

  it('takes the description from the alert, which names the merchant', () => {
    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({ source: 'STATEMENT', description: 'POS/1234/TRF' }),
      ),
      withId(
        '01KZ0BS0000000000000000002',
        observation({ source: 'SMS', description: 'POS PURCHASE AT SHOPRITE IKEJA' }),
      ),
    ];

    expect(projectTransaction(set).description).toBe('POS PURCHASE AT SHOPRITE IKEJA');
  });

  it('skips observations with no usable description rather than blanking the field', () => {
    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({ source: 'USER_STATED', description: '   ' }),
      ),
      withId('01KZ0BS0000000000000000002', observation({ source: 'SMS', description: 'FUEL' })),
    ];

    expect(projectTransaction(set).description).toBe('FUEL');
  });

  it('falls back to a fixed label rather than inventing a description', () => {
    expect(projectTransaction([observation({ source: 'SMS' })]).description).toBe(
      UNLABELLED_DESCRIPTION,
    );
  });

  it('reports the latest balance reading regardless of source rank', () => {
    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({
          source: 'STATEMENT',
          occurredAt: new Date('2026-08-07T10:00:00.000Z'),
          balanceAfterMinor: 100_000n,
        }),
      ),
      withId(
        '01KZ0BS0000000000000000002',
        observation({
          source: 'SMS',
          occurredAt: new Date('2026-08-07T10:00:30.000Z'),
          balanceAfterMinor: 90_000n,
        }),
      ),
    ];

    expect(projectTransaction(set).balanceAfterMinor).toBe(90_000n);
  });

  it('records an amount disagreement instead of resolving it silently', () => {
    const set: ObservationSet = [
      withId('01KZ0BS0000000000000000001', observation({ source: 'SMS', amountMinor: 500_000n })),
      withId(
        '01KZ0BS0000000000000000002',
        observation({ source: 'STATEMENT', amountMinor: 499_900n }),
      ),
    ];

    expect(projectTransaction(set).conflicts).toEqual([
      { field: 'amount', chosen: '499900', rejected: ['500000'] },
    ]);
  });

  it('does not treat differing timestamps or descriptions as conflicts', () => {
    const set: ObservationSet = [
      withId(
        '01KZ0BS0000000000000000001',
        observation({
          source: 'SMS',
          description: 'SHOPRITE',
          occurredAt: new Date('2026-08-07T10:00:00.000Z'),
        }),
      ),
      withId(
        '01KZ0BS0000000000000000002',
        observation({
          source: 'STATEMENT',
          description: 'POS/1234',
          occurredAt: new Date('2026-08-09T00:00:00.000Z'),
        }),
      ),
    ];

    expect(projectTransaction(set).conflicts).toEqual([]);
  });

  /**
   * Determinism is the property the whole ledger rests on (ADR-008), so it is asserted
   * directly rather than assumed from the absence of obvious nondeterminism.
   */
  it('is order-independent: any permutation projects identically', () => {
    const a = withId(
      '01KZ0BS0000000000000000001',
      observation({ source: 'SMS', description: 'SHOPRITE', balanceAfterMinor: 90_000n }),
    );
    const b = withId(
      '01KZ0BS0000000000000000002',
      observation({ source: 'STATEMENT', amountMinor: 499_900n, description: 'POS/1234' }),
    );
    const c = withId(
      '01KZ0BS0000000000000000003',
      observation({ source: 'USER_STATED', description: 'Groceries' }),
    );

    const permutations: ObservationSet[] = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b],
    ];

    const [first, ...rest] = permutations.map(projectTransaction);
    for (const projected of rest) expect(projected).toEqual(first);
  });

  it('breaks same-source, same-instant ties by id so the result stays a function', () => {
    const shared = { source: 'SMS' as const, observedAt: new Date('2026-08-07T10:00:05.000Z') };

    const lower = withId(
      '01KZ0BS0000000000000000001',
      observation({ ...shared, description: 'FIRST' }),
    );
    const higher = withId(
      '01KZ0BS0000000000000000002',
      observation({ ...shared, description: 'SECOND' }),
    );

    expect(projectTransaction([lower, higher]).description).toBe('SECOND');
    expect(projectTransaction([higher, lower]).description).toBe('SECOND');
  });
});
