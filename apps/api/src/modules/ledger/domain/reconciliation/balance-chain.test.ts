import { describe, expect, it } from 'vitest';
import { type CurrencyCode, toId } from '@atlas/shared-kernel';
import { type BalanceReading, detectGaps, type SuspectedGap } from './balance-chain';

/**
 * Asserts exactly one gap and returns it. A helper rather than optional chaining at each
 * assertion: "there is precisely one gap" is itself part of what these tests check.
 */
function onlyGap(gaps: readonly SuspectedGap[]): SuspectedGap {
  expect(gaps).toHaveLength(1);
  const [gap] = gaps;
  if (gap === undefined) throw new Error('unreachable: length asserted above');
  return gap;
}

const NGN = 'NGN' as CurrencyCode;

let sequence = 0;

function reading(
  balanceAfterMinor: bigint | null,
  amountMinor: bigint,
  direction: 'DEBIT' | 'CREDIT',
  isoTime: string,
): BalanceReading {
  sequence += 1;

  return {
    transactionId: toId<'TransactionId'>(`01KZTXN${String(sequence).padStart(19, '0')}`),
    occurredAt: new Date(isoTime),
    amountMinor,
    direction,
    balanceAfterMinor,
  };
}

describe('detectGaps', () => {
  it('finds nothing when the arithmetic closes', () => {
    const readings = [
      reading(1_000_000n, 200_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(800_000n, 200_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
      reading(1_300_000n, 500_000n, 'CREDIT', '2026-08-03T09:00:00.000Z'),
    ];

    expect(detectGaps(readings, NGN)).toEqual([]);
  });

  it('reports unrecorded spending when the balance fell further than it should have', () => {
    const readings = [
      reading(1_000_000n, 200_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      // Expected 800,000 after a 200,000 debit; the bank says 680,000, so 120,000 left
      // the account without an alert Atlas ever saw.
      reading(680_000n, 200_000n, 'DEBIT', '2026-08-03T09:00:00.000Z'),
    ];

    const gap = onlyGap(detectGaps(readings, NGN));

    expect(gap.amount.minor).toBe(120_000n);
    expect(gap.missingDirection).toBe('DEBIT');
    expect(gap.afterAt).toEqual(new Date('2026-08-01T09:00:00.000Z'));
    expect(gap.beforeAt).toEqual(new Date('2026-08-03T09:00:00.000Z'));
  });

  it('reports unrecorded income when the balance rose more than it should have', () => {
    const readings = [
      reading(1_000_000n, 200_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(950_000n, 200_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
    ];

    const gap = onlyGap(detectGaps(readings, NGN));

    expect(gap.amount.minor).toBe(150_000n);
    expect(gap.missingDirection).toBe('CREDIT');
  });

  /**
   * A transaction with no balance reading is not a gap — its amount is still known, so the
   * chain can be verified straight across it. Only money with *no transaction at all*
   * counts as missing.
   */
  it('verifies across a transaction that reported no balance', () => {
    const readings = [
      reading(1_000_000n, 200_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(null, 300_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
      reading(700_000n, 0n, 'DEBIT', '2026-08-03T09:00:00.000Z'),
    ];

    expect(detectGaps(readings, NGN)).toEqual([]);
  });

  it('still detects a gap that hides behind a balance-less transaction', () => {
    const readings = [
      reading(1_000_000n, 200_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(null, 300_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
      reading(650_000n, 0n, 'DEBIT', '2026-08-03T09:00:00.000Z'),
    ];

    const gap = onlyGap(detectGaps(readings, NGN));

    expect(gap.amount.minor).toBe(50_000n);
  });

  /**
   * The conservative half of R11. Two transactions stamped to the same instant have no
   * knowable order, so the intermediate balance may legitimately not match — checkpointing
   * there would invent a gap out of a tie.
   */
  it('does not checkpoint on a timestamp shared by several readings', () => {
    const sameInstant = '2026-08-02T09:00:00.000Z';
    const readings = [
      reading(1_000_000n, 100_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(900_000n, 100_000n, 'DEBIT', sameInstant),
      reading(700_000n, 200_000n, 'DEBIT', sameInstant),
      reading(650_000n, 50_000n, 'DEBIT', '2026-08-03T09:00:00.000Z'),
    ];

    // The tied pair is skipped as a checkpoint but still counted arithmetically:
    // 1,000,000 - 100,000 - 200,000 - 50,000 = 650,000, so the chain closes.
    expect(detectGaps(readings, NGN)).toEqual([]);
  });

  it('re-anchors after a gap so the same missing money is not reported twice', () => {
    const readings = [
      reading(1_000_000n, 100_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
      reading(800_000n, 100_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
      reading(700_000n, 100_000n, 'DEBIT', '2026-08-03T09:00:00.000Z'),
    ];

    const gap = onlyGap(detectGaps(readings, NGN));

    expect(gap.amount.minor).toBe(100_000n);
  });

  it('reports nothing without at least two balance readings to compare', () => {
    expect(detectGaps([], NGN)).toEqual([]);
    expect(
      detectGaps([reading(1_000_000n, 100_000n, 'DEBIT', '2026-08-01T09:00:00.000Z')], NGN),
    ).toEqual([]);
    expect(
      detectGaps(
        [
          reading(null, 100_000n, 'DEBIT', '2026-08-01T09:00:00.000Z'),
          reading(null, 100_000n, 'DEBIT', '2026-08-02T09:00:00.000Z'),
        ],
        NGN,
      ),
    ).toEqual([]);
  });

  it('names the transactions bracketing the gap, so the question can be specific', () => {
    const first = reading(1_000_000n, 100_000n, 'DEBIT', '2026-08-01T09:00:00.000Z');
    const second = reading(800_000n, 100_000n, 'DEBIT', '2026-08-05T09:00:00.000Z');

    const gap = onlyGap(detectGaps([first, second], NGN));

    expect(gap.afterTransactionId).toBe(first.transactionId);
    expect(gap.beforeTransactionId).toBe(second.transactionId);
  });
});
