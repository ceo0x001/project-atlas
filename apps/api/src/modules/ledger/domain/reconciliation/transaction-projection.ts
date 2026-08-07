import type { CurrencyCode, ObservationId } from '@atlas/shared-kernel';
import {
  highestPrecedence,
  type ObservationFacts,
  type TransactionDirection,
} from './observation-facts';

/**
 * Projects a set of observations into the canonical fields of one transaction (ADR-008).
 *
 * This is the function the ledger's truthfulness rests on. It is pure and total: the same
 * observation set always yields the same result, on every machine, forever. Nothing is
 * ever authored directly onto a transaction — which is what makes merging (union the sets
 * and re-project) and splitting (move an observation out and re-project both) the same
 * mechanism rather than two.
 *
 * The input type is non-empty by construction. A transaction with no observations is not
 * a state to handle at runtime, it is a bug, so the compiler rejects it instead.
 */

export type ObservationSet = readonly [ObservationFacts, ...ObservationFacts[]];

/**
 * A field where sources disagreed. Recorded rather than resolved-and-forgotten: a
 * disagreement about how much money moved is exactly the thing a user should be able to
 * see, and it is also evidence that a merge may have been wrong.
 */
export interface ProjectionConflict {
  readonly field: 'amount' | 'currency' | 'direction';
  readonly chosen: string;
  readonly rejected: readonly string[];
}

export interface CanonicalFields {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly direction: TransactionDirection;
  readonly occurredAt: Date;
  readonly description: string;
  readonly balanceAfterMinor: bigint | null;
  /** Which observation supplied each field, for provenance (invariant I6). */
  readonly sourcedFrom: {
    readonly amount: ObservationId;
    readonly occurredAt: ObservationId;
    readonly description: ObservationId | null;
    readonly balanceAfter: ObservationId | null;
  };
  readonly conflicts: readonly ProjectionConflict[];
}

/** Used when no observation carried a description. Never invented from other fields. */
export const UNLABELLED_DESCRIPTION = 'Unlabelled transaction';

export function projectTransaction(observations: ObservationSet): CanonicalFields {
  // Non-null: `highestPrecedence` with no eligibility filter always returns a winner
  // from a non-empty set, and the input type guarantees non-emptiness.
  const amountSource = highestPrecedence(observations, 'amount') as ObservationFacts;
  const timeSource = highestPrecedence(observations, 'time') as ObservationFacts;

  const descriptionSource = highestPrecedence(observations, 'description', (observation) =>
    hasText(observation.description),
  );

  const balanceSource = latestBalanceReading(observations);

  return {
    amountMinor: amountSource.amountMinor,
    currency: amountSource.currency,
    direction: amountSource.direction,
    occurredAt: timeSource.occurredAt,
    description: descriptionSource?.description?.trim() ?? UNLABELLED_DESCRIPTION,
    balanceAfterMinor: balanceSource?.balanceAfterMinor ?? null,
    sourcedFrom: {
      amount: amountSource.id,
      occurredAt: timeSource.id,
      description: descriptionSource?.id ?? null,
      balanceAfter: balanceSource?.id ?? null,
    },
    conflicts: collectConflicts(observations, amountSource),
  };
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * The balance to report is a point-in-time reading, not a property of the transaction, so
 * source precedence is the wrong tool: the *latest* reading is the most useful one
 * regardless of who reported it. Ties resolve by id so the result stays deterministic.
 */
function latestBalanceReading(observations: ObservationSet): ObservationFacts | null {
  let latest: ObservationFacts | null = null;

  for (const candidate of observations) {
    if (candidate.balanceAfterMinor === null) continue;
    if (latest === null || isLaterReading(candidate, latest)) latest = candidate;
  }

  return latest;
}

function isLaterReading(candidate: ObservationFacts, incumbent: ObservationFacts): boolean {
  const candidateTime = candidate.occurredAt.getTime();
  const incumbentTime = incumbent.occurredAt.getTime();
  if (candidateTime !== incumbentTime) return candidateTime > incumbentTime;
  return candidate.id > incumbent.id;
}

/**
 * Records where sources disagreed about the money itself.
 *
 * Only amount, currency and direction are treated as conflicts. Differing timestamps and
 * descriptions are normal and expected — that is what the per-field precedence exists to
 * resolve — whereas two sources disagreeing about *how much* moved means either a bad
 * parse or a wrong merge, and both deserve to be visible.
 */
function collectConflicts(
  observations: ObservationSet,
  chosen: ObservationFacts,
): readonly ProjectionConflict[] {
  const conflicts: ProjectionConflict[] = [];

  const rejectedAmounts = distinctExcluding(
    observations.map((observation) => observation.amountMinor.toString()),
    chosen.amountMinor.toString(),
  );
  if (rejectedAmounts.length > 0) {
    conflicts.push({
      field: 'amount',
      chosen: chosen.amountMinor.toString(),
      rejected: rejectedAmounts,
    });
  }

  const rejectedCurrencies = distinctExcluding(
    observations.map((observation) => observation.currency),
    chosen.currency,
  );
  if (rejectedCurrencies.length > 0) {
    conflicts.push({ field: 'currency', chosen: chosen.currency, rejected: rejectedCurrencies });
  }

  const rejectedDirections = distinctExcluding(
    observations.map((observation) => observation.direction),
    chosen.direction,
  );
  if (rejectedDirections.length > 0) {
    conflicts.push({ field: 'direction', chosen: chosen.direction, rejected: rejectedDirections });
  }

  return conflicts;
}

function distinctExcluding(values: readonly string[], excluded: string): readonly string[] {
  return [...new Set(values.filter((value) => value !== excluded))].sort();
}
