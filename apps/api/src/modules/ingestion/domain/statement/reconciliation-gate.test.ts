import { describe, expect, it } from 'vitest';
import { type CurrencyCode, Money } from '@atlas/shared-kernel';
import { applyReconciliationGate, describeRejection } from './reconciliation-gate';
import type { StatementRow } from './statement-row';

const NGN = 'NGN' as CurrencyCode;

function row(
  lineNumber: number,
  isoDate: string,
  amountMinor: bigint,
  direction: 'DEBIT' | 'CREDIT',
  balanceMinor: bigint | null,
): StatementRow {
  return {
    lineNumber,
    occurredAt: new Date(isoDate),
    description: `line ${lineNumber}`,
    amount: Money.of(amountMinor, NGN),
    direction,
    balanceAfter: balanceMinor === null ? null : Money.of(balanceMinor, NGN),
    reference: null,
  };
}

/** 1,000,000 → debit 200,000 → credit 50,000 → 850,000. Internally consistent. */
const CONSISTENT: readonly StatementRow[] = [
  row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
  row(3, '2026-08-02', 50_000n, 'CREDIT', 850_000n),
];

describe('the balance-chain check', () => {
  it('accepts a statement whose running balance adds up', () => {
    const result = applyReconciliationGate(CONSISTENT, NGN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.method).toBe('balance-chain');
    expect(result.value.openingBalance?.minor).toBe(1_000_000n);
    expect(result.value.closingBalance?.minor).toBe(850_000n);
    expect(result.value.netMovement.minor).toBe(-150_000n);
  });

  /**
   * The failure the gate exists for. A parser that reads nine rows out of ten would otherwise
   * import a total wrong by exactly the missing row, invisibly.
   */
  it('rejects when a row is missing, naming the line where the chain breaks', () => {
    const missingMiddle = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      // A 120,000 debit happened here and was not parsed.
      row(3, '2026-08-03', 50_000n, 'CREDIT', 730_000n),
    ];

    const result = applyReconciliationGate(missingMiddle, NGN);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.rejection).toEqual({
      kind: 'balance-chain-broken',
      lineNumber: 3,
      expected: '8500.00',
      actual: '7300.00',
    });
  });

  it('rejects a misread amount', () => {
    const wrongAmount = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      // Amount read as 5,000 instead of 50,000.
      row(3, '2026-08-02', 5_000n, 'CREDIT', 850_000n),
    ];

    expect(applyReconciliationGate(wrongAmount, NGN).ok).toBe(false);
  });

  it('rejects a direction read the wrong way round on any row after the first', () => {
    const flipped = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      // Really a credit; read as a debit.
      row(3, '2026-08-02', 50_000n, 'DEBIT', 850_000n),
    ];

    expect(applyReconciliationGate(flipped, NGN).ok).toBe(false);
  });

  /**
   * The one blind spot in the chain, pinned so it is known rather than discovered.
   *
   * The opening balance is derived from the first row, so if *that* row's direction is read
   * backwards the derived opening absorbs the error and the arithmetic still closes. Every
   * later row is protected, because its predecessor's balance is already pinned.
   */
  it('cannot see a flipped direction on the first row when no opening is stated', () => {
    const flippedFirst = [
      row(2, '2026-08-01', 200_000n, 'CREDIT', 800_000n),
      row(3, '2026-08-02', 50_000n, 'CREDIT', 850_000n),
    ];

    expect(applyReconciliationGate(flippedFirst, NGN).ok).toBe(true);
  });

  /** ...and supplying the statement's own opening figure closes that gap. */
  it('catches a flipped first row once an opening balance is stated', () => {
    const flippedFirst = [
      row(2, '2026-08-01', 200_000n, 'CREDIT', 800_000n),
      row(3, '2026-08-02', 50_000n, 'CREDIT', 850_000n),
    ];

    const result = applyReconciliationGate(flippedFirst, NGN, {
      opening: Money.of(1_000_000n, NGN),
      closing: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toEqual({
        kind: 'opening-balance-mismatch',
        derived: '6000.00',
        stated: '10000.00',
      });
    }
  });

  it('accepts when the stated opening agrees with the rows', () => {
    const result = applyReconciliationGate(CONSISTENT, NGN, {
      opening: Money.of(1_000_000n, NGN),
      closing: null,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a duplicated row', () => {
    const duplicated = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      row(3, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      row(4, '2026-08-02', 50_000n, 'CREDIT', 850_000n),
    ];

    expect(applyReconciliationGate(duplicated, NGN).ok).toBe(false);
  });

  it('accepts a single-row statement', () => {
    const result = applyReconciliationGate(
      [row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n)],
      NGN,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.openingBalance?.minor).toBe(1_000_000n);
  });

  it('handles an account going overdrawn', () => {
    const overdrawn = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', -50_000n),
      row(3, '2026-08-02', 100_000n, 'CREDIT', 50_000n),
    ];

    expect(applyReconciliationGate(overdrawn, NGN).ok).toBe(true);
  });
});

describe('the endpoints check', () => {
  const noBalances: readonly StatementRow[] = [
    row(2, '2026-08-01', 200_000n, 'DEBIT', null),
    row(3, '2026-08-02', 50_000n, 'CREDIT', null),
  ];

  it('accepts when the rows bridge the stated balances', () => {
    const result = applyReconciliationGate(noBalances, NGN, {
      opening: Money.of(1_000_000n, NGN),
      closing: Money.of(850_000n, NGN),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe('endpoints');
  });

  it('rejects when they do not', () => {
    const result = applyReconciliationGate(noBalances, NGN, {
      opening: Money.of(1_000_000n, NGN),
      closing: Money.of(900_000n, NGN),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.rejection).toEqual({
      kind: 'endpoints-do-not-bridge',
      expectedClosing: '8500.00',
      statedClosing: '9000.00',
    });
  });

  /**
   * The documented weakness of the endpoints method, pinned so nobody later believes it is as
   * strong as the chain. Two errors that cancel out pass — which is exactly why the balance
   * chain is preferred whenever the column exists.
   */
  it('cannot catch two errors that cancel out', () => {
    const compensating = [
      row(2, '2026-08-01', 300_000n, 'DEBIT', null), // 100,000 too much
      row(3, '2026-08-02', 150_000n, 'CREDIT', null), // 100,000 too much
    ];

    const result = applyReconciliationGate(compensating, NGN, {
      opening: Money.of(1_000_000n, NGN),
      closing: Money.of(850_000n, NGN),
    });

    expect(result.ok).toBe(true);
  });
});

describe('refusing what cannot be verified', () => {
  /**
   * The most important rule here. An unverifiable import is not a safer version of one that
   * fails a check — it is the same risk with the warning removed.
   */
  it('rejects a statement with neither balances nor stated endpoints', () => {
    const result = applyReconciliationGate([row(2, '2026-08-01', 200_000n, 'DEBIT', null)], NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('unverifiable');
  });

  it('rejects when only some rows carry a balance', () => {
    const partial = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      row(3, '2026-08-02', 50_000n, 'CREDIT', null),
    ];

    // Intermittent detection of the balance column is itself evidence the mapping is wrong.
    expect(applyReconciliationGate(partial, NGN).ok).toBe(false);
  });

  it('rejects an empty statement', () => {
    const result = applyReconciliationGate([], NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('no-rows');
  });

  /** Sorting would hide a mis-parsed date column and produce a plausible, wrong statement. */
  it('rejects rows that are not chronological rather than sorting them', () => {
    const outOfOrder = [
      row(2, '2026-08-05', 200_000n, 'DEBIT', 800_000n),
      row(3, '2026-08-01', 50_000n, 'CREDIT', 850_000n),
    ];

    const result = applyReconciliationGate(outOfOrder, NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ kind: 'rows-out-of-order', lineNumber: 3 });
  });

  it('allows several rows on the same day', () => {
    const sameDay = [
      row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
      row(3, '2026-08-01', 50_000n, 'CREDIT', 850_000n),
    ];

    expect(applyReconciliationGate(sameDay, NGN).ok).toBe(true);
  });

  it('rejects rows in a different currency from the one declared', () => {
    const usd = [
      {
        ...row(2, '2026-08-01', 200_000n, 'DEBIT', 800_000n),
        amount: Money.of(200_000n, 'USD' as CurrencyCode),
        balanceAfter: Money.of(800_000n, 'USD' as CurrencyCode),
      },
    ];

    const result = applyReconciliationGate(usd, NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('mixed-currency');
  });
});

describe('describeRejection', () => {
  it('names the line and both figures, so a person can find the problem', () => {
    const message = describeRejection({
      kind: 'balance-chain-broken',
      lineNumber: 14,
      expected: '8500.00',
      actual: '7300.00',
    });

    expect(message).toContain('line 14');
    expect(message).toContain('8500.00');
    expect(message).toContain('7300.00');
    expect(message).toContain('nothing has been imported');
  });

  it('always says nothing was imported, for every rejection that could mislead', () => {
    const kinds = [
      { kind: 'balance-chain-broken', lineNumber: 1, expected: '1', actual: '2' },
      { kind: 'endpoints-do-not-bridge', expectedClosing: '1', statedClosing: '2' },
      { kind: 'unverifiable' },
      { kind: 'rows-out-of-order', lineNumber: 3 },
    ] as const;

    for (const rejection of kinds) {
      expect(describeRejection(rejection).toLowerCase()).toContain('nothing has been imported');
    }
  });
});
