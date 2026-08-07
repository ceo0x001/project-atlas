import { type CurrencyCode, Money, type TransactionId } from '@atlas/shared-kernel';
import type { TransactionDirection } from './observation-facts';

/**
 * Detects missing transactions from balance discontinuities.
 *
 * Nigerian bank alerts almost always state the balance after the transaction, which gives
 * the ledger a second, independent check on itself: given a starting balance and every
 * transaction since, the ending balance is arithmetic. When the arithmetic does not close,
 * money moved that Atlas has no transaction for.
 *
 * ## What this deliberately does not do
 *
 * It does not create the missing transaction. The discrepancy tells us an amount and a
 * time range and nothing else — no merchant, no direction we can trust, no description.
 * Materialising a transaction from it would put a figure in the ledger that no source ever
 * reported, which is precisely the "never hallucinate financial information" invariant.
 * A gap is a **question to ask the user**, and it stays one.
 *
 * ## Why gaps are computed, never scheduled
 *
 * This is a pure function over readings the ledger already holds, so there is nothing to
 * keep up to date and no job to run. That is the reason M2 needs no Temporal: the fact is
 * derivable on demand, and a stored copy could only ever be stale.
 */

export interface BalanceReading {
  readonly transactionId: TransactionId;
  readonly occurredAt: Date;
  readonly amountMinor: bigint;
  readonly direction: TransactionDirection;
  /** Null when the source reported no balance. Such transactions still count arithmetically. */
  readonly balanceAfterMinor: bigint | null;
}

export interface SuspectedGap {
  /** Size of the unexplained movement. Always positive. */
  readonly amount: Money;
  /**
   * Direction of the activity Atlas is missing. A balance lower than expected means
   * unrecorded money went out.
   */
  readonly missingDirection: TransactionDirection;
  /** The gap lies after this checkpoint... */
  readonly afterAt: Date;
  /** ...and at or before this one. */
  readonly beforeAt: Date;
  readonly afterTransactionId: TransactionId;
  readonly beforeTransactionId: TransactionId;
}

/**
 * @param readings One account, one currency, ordered by `occurredAt` ascending. The caller
 *   owns that filtering because mixing accounts or currencies here would produce confident
 *   nonsense.
 */
export function detectGaps(
  readings: readonly BalanceReading[],
  currency: CurrencyCode,
): readonly SuspectedGap[] {
  const gaps: SuspectedGap[] = [];
  const ambiguous = timestampsSharedBySeveralReadings(readings);

  // Carrying the anchor's balance as a Money keeps its non-null-ness in the type rather
  // than asserting it later.
  let anchor: { readonly reading: BalanceReading; readonly balance: Money } | null = null;
  let movementSinceAnchor = Money.zero(currency);

  for (const reading of readings) {
    if (anchor !== null) {
      movementSinceAnchor = movementSinceAnchor.plus(signedAmount(reading, currency));
    }

    if (reading.balanceAfterMinor === null) continue;

    // A timestamp shared by several readings gives no reliable ordering, so it cannot
    // serve as a checkpoint. Skipping it keeps accumulating instead — the next
    // unambiguous reading still verifies the whole span, just less precisely.
    if (ambiguous.has(reading.occurredAt.getTime())) continue;

    const balance = Money.of(reading.balanceAfterMinor, currency);

    if (anchor === null) {
      anchor = { reading, balance };
      movementSinceAnchor = Money.zero(currency);
      continue;
    }

    const expected = anchor.balance.plus(movementSinceAnchor);

    if (!expected.equals(balance)) {
      const discrepancy = balance.minus(expected);

      gaps.push({
        amount: discrepancy.abs(),
        // Balance below expectation means unrecorded money left the account.
        missingDirection: discrepancy.isNegative ? 'DEBIT' : 'CREDIT',
        afterAt: anchor.reading.occurredAt,
        beforeAt: reading.occurredAt,
        afterTransactionId: anchor.reading.transactionId,
        beforeTransactionId: reading.transactionId,
      });
    }

    // Re-anchor either way. After a gap the old anchor is known-unreliable, and carrying
    // it forward would report the same missing money again at every later checkpoint.
    anchor = { reading, balance };
    movementSinceAnchor = Money.zero(currency);
  }

  return gaps;
}

/**
 * A credit raises the balance, a debit lowers it. Expressed through Money rather than raw
 * bigint arithmetic so currency mismatches fail loudly (invariant I3).
 */
function signedAmount(reading: BalanceReading, currency: CurrencyCode): Money {
  const magnitude = Money.of(reading.amountMinor, currency);
  return reading.direction === 'CREDIT' ? magnitude : magnitude.negate();
}

/**
 * Timestamps carried by more than one balance reading.
 *
 * Two transactions stamped to the same second have no knowable order, so the intermediate
 * balance either of them reports may legitimately not match — checkpointing there would
 * invent a gap out of a tie. This is the conservative half of R11: when ordering is
 * unknown, narrow the claim rather than widen it.
 */
function timestampsSharedBySeveralReadings(
  readings: readonly BalanceReading[],
): ReadonlySet<number> {
  const seen = new Set<number>();
  const shared = new Set<number>();

  for (const reading of readings) {
    if (reading.balanceAfterMinor === null) continue;

    const time = reading.occurredAt.getTime();
    if (seen.has(time)) shared.add(time);
    seen.add(time);
  }

  return shared;
}
