import { describe, expect, it } from 'vitest';
import { type CurrencyCode, toId } from '@atlas/shared-kernel';
import type { ObservationFacts, ObservationSource } from './observation-facts';
import { type CandidateTransaction, decideMatch } from './match-decision';

const NGN = 'NGN' as CurrencyCode;
const ACCOUNT = toId<'AccountId'>('01KZACC0000000000000000001');
const OTHER_ACCOUNT = toId<'AccountId'>('01KZACC0000000000000000002');
const AT = new Date('2026-08-07T10:00:00.000Z');

function incoming(overrides: Partial<ObservationFacts> = {}): ObservationFacts {
  return {
    id: toId<'ObservationId'>('01KZ0BS0000000000000000001'),
    source: 'STATEMENT',
    amountMinor: 500_000n,
    currency: NGN,
    direction: 'DEBIT',
    occurredAt: AT,
    balanceAfterMinor: null,
    description: null,
    rawReference: null,
    observedAt: AT,
    ...overrides,
  };
}

function candidate(
  id: string,
  overrides: Partial<CandidateTransaction> = {},
): CandidateTransaction {
  return {
    id: toId<'TransactionId'>(id),
    accountId: ACCOUNT,
    amountMinor: 500_000n,
    currency: NGN,
    direction: 'DEBIT',
    occurredAt: AT,
    balanceAfterMinor: null,
    references: [],
    sources: ['SMS'] as readonly ObservationSource[],
    ...overrides,
  };
}

const FIRST = '01KZTXN0000000000000000001';
const SECOND = '01KZTXN0000000000000000002';

describe('decideMatch — hard criteria', () => {
  it('finds no candidate when nothing was booked', () => {
    expect(decideMatch(incoming(), ACCOUNT, [])).toEqual({
      kind: 'separate',
      reason: 'no-candidate',
    });
  });

  it.each([
    ['a different account', { accountId: OTHER_ACCOUNT }],
    ['a different currency', { currency: 'USD' as CurrencyCode }],
    ['the opposite direction', { direction: 'CREDIT' as const }],
  ])('excludes a candidate on %s', (_label, overrides) => {
    const decision = decideMatch(incoming(), ACCOUNT, [candidate(FIRST, overrides)]);

    expect(decision).toEqual({ kind: 'separate', reason: 'no-candidate' });
  });

  /**
   * Amount tolerance is the fastest route to an over-merge, which silently understates
   * spending. One kobo apart must be two transactions.
   */
  it.each([
    ['one kobo higher', 500_001n],
    ['one kobo lower', 499_999n],
    ['plausibly close', 505_000n],
  ])('never merges an amount %s', (_label, amountMinor) => {
    const decision = decideMatch(incoming(), ACCOUNT, [candidate(FIRST, { amountMinor })]);

    expect(decision).toEqual({ kind: 'separate', reason: 'no-candidate' });
  });
});

describe('decideMatch — time windows', () => {
  it('accepts statement-to-alert skew inside 36 hours', () => {
    const decision = decideMatch(
      incoming({
        source: 'STATEMENT',
        occurredAt: new Date('2026-08-08T20:00:00.000Z'),
        balanceAfterMinor: 90_000n,
      }),
      ACCOUNT,
      [candidate(FIRST, { balanceAfterMinor: 90_000n, occurredAt: AT })],
    );

    expect(decision).toMatchObject({ kind: 'merge', evidence: { secondsApart: 122_400 } });
  });

  it('rejects statement-to-alert skew beyond 36 hours', () => {
    const decision = decideMatch(
      incoming({ source: 'STATEMENT', occurredAt: new Date('2026-08-09T00:00:00.000Z') }),
      ACCOUNT,
      [candidate(FIRST, { occurredAt: AT })],
    );

    expect(decision).toEqual({ kind: 'separate', reason: 'no-candidate' });
  });

  /**
   * Between two alerts the window is 90 seconds, not 36 hours: a wide window there would
   * only manufacture ambiguity between genuinely separate transactions.
   */
  it('holds alert-to-alert to a 90 second window', () => {
    const withinWindow = decideMatch(
      incoming({ source: 'EMAIL', occurredAt: new Date('2026-08-07T10:01:00.000Z') }),
      ACCOUNT,
      [candidate(FIRST, { sources: ['SMS'] })],
    );
    const outsideWindow = decideMatch(
      incoming({ source: 'EMAIL', occurredAt: new Date('2026-08-07T10:05:00.000Z') }),
      ACCOUNT,
      [candidate(FIRST, { sources: ['SMS'] })],
    );

    expect(withinWindow.kind).toBe('ask');
    expect(outsideWindow).toEqual({ kind: 'separate', reason: 'no-candidate' });
  });
});

describe('decideMatch — vetoes', () => {
  it('vetoes on a reference the bank labelled differently, however well else it matches', () => {
    const decision = decideMatch(
      incoming({ rawReference: 'REF-999', balanceAfterMinor: 90_000n }),
      ACCOUNT,
      [candidate(FIRST, { references: ['REF-123'], balanceAfterMinor: 90_000n })],
    );

    expect(decision).toEqual({ kind: 'separate', reason: 'reference-mismatch' });
  });

  it('vetoes when the two report different balances after the transaction', () => {
    const decision = decideMatch(incoming({ balanceAfterMinor: 90_000n }), ACCOUNT, [
      candidate(FIRST, { balanceAfterMinor: 80_000n }),
    ]);

    expect(decision).toEqual({ kind: 'separate', reason: 'balance-mismatch' });
  });

  it('reports the reference veto ahead of the balance veto', () => {
    const decision = decideMatch(
      incoming({ rawReference: 'REF-999', balanceAfterMinor: 90_000n }),
      ACCOUNT,
      [
        candidate(FIRST, { balanceAfterMinor: 80_000n }),
        candidate(SECOND, { references: ['REF-123'], balanceAfterMinor: 90_000n }),
      ],
    );

    expect(decision).toEqual({ kind: 'separate', reason: 'reference-mismatch' });
  });
});

describe('decideMatch — corroboration', () => {
  it('merges on an equal reference, ignoring case and spacing', () => {
    const decision = decideMatch(incoming({ rawReference: 'ref  123' }), ACCOUNT, [
      candidate(FIRST, { references: ['REF 123 '] }),
    ]);

    expect(decision).toMatchObject({ kind: 'merge', into: FIRST });
  });

  /**
   * Normalisation stops at case and whitespace, deliberately. A looser normaliser that
   * also stripped separators would produce false reference *equality*, and reference
   * equality auto-merges — the invisible failure. Being too strict only ever costs a
   * visible duplicate the user can fix, so strictness is the safe direction.
   */
  it('does not treat differently-punctuated references as equal', () => {
    const decision = decideMatch(incoming({ rawReference: 'REF123' }), ACCOUNT, [
      candidate(FIRST, { references: ['REF-123'] }),
    ]);

    expect(decision).toEqual({ kind: 'separate', reason: 'reference-mismatch' });
  });

  it('merges on an equal balance', () => {
    const decision = decideMatch(incoming({ balanceAfterMinor: 90_000n }), ACCOUNT, [
      candidate(FIRST, { balanceAfterMinor: 90_000n }),
    ]);

    expect(decision).toMatchObject({
      kind: 'merge',
      into: FIRST,
      evidence: { balanceEqual: true },
    });
  });

  it('merges the corroborated candidate even beside an uncorroborated look-alike', () => {
    const decision = decideMatch(incoming({ balanceAfterMinor: 90_000n }), ACCOUNT, [
      candidate(FIRST),
      candidate(SECOND, { balanceAfterMinor: 90_000n }),
    ]);

    expect(decision).toMatchObject({ kind: 'merge', into: SECOND });
  });

  it('records how many look-alikes existed, so a merge stays reviewable', () => {
    const decision = decideMatch(incoming({ balanceAfterMinor: 90_000n }), ACCOUNT, [
      candidate(FIRST),
      candidate(SECOND, { balanceAfterMinor: 90_000n }),
    ]);

    expect(decision).toMatchObject({ evidence: { candidateCount: 2 } });
  });

  it('refuses when two candidates are independently corroborated', () => {
    const decision = decideMatch(incoming({ rawReference: 'REF-123' }), ACCOUNT, [
      candidate(FIRST, { references: ['REF-123'] }),
      candidate(SECOND, { references: ['REF-123'] }),
    ]);

    expect(decision).toEqual({ kind: 'separate', reason: 'ambiguous-candidates' });
  });
});

describe('decideMatch — asking rather than guessing', () => {
  it('asks when only amount and timing agree', () => {
    const decision = decideMatch(incoming(), ACCOUNT, [candidate(FIRST)]);

    expect(decision).toMatchObject({ kind: 'ask', candidate: FIRST });
  });

  /**
   * F2, and the failure that would steal money from the user's own history: two genuine
   * ₦100 airtime top-ups on one day are indistinguishable, so guessing understates
   * spending. Refusing leaves a visible duplicate the user can correct.
   */
  it('leaves two indistinguishable same-day transactions alone', () => {
    const decision = decideMatch(incoming({ amountMinor: 10_000n }), ACCOUNT, [
      candidate(FIRST, { amountMinor: 10_000n }),
      candidate(SECOND, { amountMinor: 10_000n }),
    ]);

    expect(decision).toEqual({ kind: 'separate', reason: 'ambiguous-candidates' });
  });

  it('treats an unknown reference on one side as no evidence, not as agreement', () => {
    const decision = decideMatch(incoming({ rawReference: 'REF-123' }), ACCOUNT, [
      candidate(FIRST, { references: [] }),
    ]);

    expect(decision).toMatchObject({ kind: 'ask', evidence: { referenceEqual: false } });
  });
});
