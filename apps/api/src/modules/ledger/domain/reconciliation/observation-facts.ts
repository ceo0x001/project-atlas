import type { CurrencyCode, ObservationId } from '@atlas/shared-kernel';

/**
 * The facts a single observation asserts about one transaction, and the per-field
 * source precedence used to project them (ADR-008).
 *
 * Everything here is pure and free of Prisma, so the projection and matching rules can
 * be exhaustively unit tested without a database. That matters more than usual: these
 * functions decide what money exists.
 */

export type ObservationSource = 'SMS' | 'EMAIL' | 'STATEMENT' | 'USER_STATED' | 'AGGREGATOR';

export type TransactionDirection = 'DEBIT' | 'CREDIT';

export interface ObservationFacts {
  readonly id: ObservationId;
  readonly source: ObservationSource;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly direction: TransactionDirection;
  /** When the money moved, as this source understands it. */
  readonly occurredAt: Date;
  /** Balance the source reported after the transaction, when it reported one. */
  readonly balanceAfterMinor: bigint | null;
  readonly description: string | null;
  /** The bank's own reference for this entry, when present. */
  readonly rawReference: string | null;
  /** When Atlas received it. Only ever a tiebreaker, never evidence about the money. */
  readonly observedAt: Date;
}

/**
 * Precedence for **amount, currency and direction** — how much money moved, and which way.
 *
 * A statement is the bank's own book of record, so it outranks an alert. The user
 * outranks the statement, not because people are more accurate than banks, but because a
 * user disputing an amount is a signal we must never silently discard: if they say the
 * figure is wrong, the right outcome is a visible disagreement, not a quiet override of
 * their correction.
 */
const AMOUNT_PRECEDENCE: Readonly<Record<ObservationSource, number>> = {
  USER_STATED: 4,
  STATEMENT: 3,
  AGGREGATOR: 2,
  SMS: 1,
  EMAIL: 1,
};

/**
 * Precedence for **occurredAt** — deliberately different, and the subtlest rule here.
 *
 * Alerts beat statements. An alert is timestamped at the moment the money moved;
 * statement rows are frequently date-only, or carry the *booking* date, which can fall
 * days later. Preferring the statement would move a 31 August purchase into September and
 * silently corrupt every month-boundary total — so the ranking inverts relative to
 * amount, on purpose.
 */
const TIME_PRECEDENCE: Readonly<Record<ObservationSource, number>> = {
  USER_STATED: 4,
  SMS: 3,
  EMAIL: 3,
  AGGREGATOR: 2,
  STATEMENT: 1,
};

/**
 * Precedence for **description**.
 *
 * Nigerian bank alerts usually name the merchant in the narration ("POS PURCHASE AT
 * SHOPRITE"), where statement rows are often terse internal codes. So alerts win here
 * too, for a different reason than they win on time.
 */
const DESCRIPTION_PRECEDENCE: Readonly<Record<ObservationSource, number>> = {
  USER_STATED: 4,
  SMS: 3,
  EMAIL: 3,
  STATEMENT: 2,
  AGGREGATOR: 1,
};

export type PrecedenceField = 'amount' | 'time' | 'description';

const PRECEDENCE_BY_FIELD: Readonly<
  Record<PrecedenceField, Readonly<Record<ObservationSource, number>>>
> = {
  amount: AMOUNT_PRECEDENCE,
  time: TIME_PRECEDENCE,
  description: DESCRIPTION_PRECEDENCE,
};

export function precedenceOf(source: ObservationSource, field: PrecedenceField): number {
  return PRECEDENCE_BY_FIELD[field][source];
}

/**
 * Picks the observation that should supply a field.
 *
 * Ties are broken by `observedAt`, then by `id`. The id tiebreak is what makes the
 * projection a *function* rather than merely usually-stable: ULIDs sort by creation, so
 * two observations recorded in the same millisecond still have a defined winner, and the
 * same observation set always projects to the same transaction on every machine.
 */
export function highestPrecedence(
  observations: readonly [ObservationFacts, ...ObservationFacts[]],
  field: PrecedenceField,
  eligible: (observation: ObservationFacts) => boolean = () => true,
): ObservationFacts | null {
  let winner: ObservationFacts | null = null;

  for (const candidate of observations) {
    if (!eligible(candidate)) continue;
    if (winner === null || beats(candidate, winner, field)) winner = candidate;
  }

  return winner;
}

function beats(
  candidate: ObservationFacts,
  incumbent: ObservationFacts,
  field: PrecedenceField,
): boolean {
  const candidateRank = precedenceOf(candidate.source, field);
  const incumbentRank = precedenceOf(incumbent.source, field);
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;

  const candidateObserved = candidate.observedAt.getTime();
  const incumbentObserved = incumbent.observedAt.getTime();
  if (candidateObserved !== incumbentObserved) return candidateObserved > incumbentObserved;

  return candidate.id > incumbent.id;
}
