import type { AccountId, CurrencyCode, TransactionId } from '@atlas/shared-kernel';
import type {
  ObservationFacts,
  ObservationSource,
  TransactionDirection,
} from './observation-facts';

/**
 * Decides whether an incoming observation describes a transaction Atlas already booked
 * (ADR-008 §4).
 *
 * ## The bias, and why it is not timidity
 *
 * The two failure modes are not symmetric:
 *
 * - **Under-merge** leaves a duplicate. The user can see it and fix it.
 * - **Over-merge** silently removes real spending from their totals. They cannot see it,
 *   and no later evidence brings it back.
 *
 * An over-merge makes Atlas quietly understate what someone spent, which is the precise
 * failure this product exists to prevent. So every ambiguous case resolves to *not*
 * merging, amounts must match exactly, and only corroboration by the bank's own reference
 * or by the reported balance earns an automatic merge. Weaker evidence becomes a question
 * for the user rather than a silent decision about their money.
 *
 * Deterministic throughout: no model participates, because a merge decides what money
 * exists.
 */

/** Booking skew between a statement row and an alert for the same purchase. */
export const STATEMENT_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Window between two alert-sourced observations — the same alert arriving by both SMS and
 * email. Tight on purpose: alerts carry real timestamps, so a wide window here would only
 * ever manufacture ambiguity between genuinely separate transactions.
 */
export const ALERT_WINDOW_MS = 90 * 1000;

export interface CandidateTransaction {
  readonly id: TransactionId;
  readonly accountId: AccountId;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly direction: TransactionDirection;
  readonly occurredAt: Date;
  readonly balanceAfterMinor: bigint | null;
  /** References carried by every observation already linked to this transaction. */
  readonly references: readonly string[];
  /** Sources already linked. Determines which time window applies. */
  readonly sources: readonly ObservationSource[];
}

export interface MatchEvidence {
  readonly referenceEqual: boolean;
  readonly balanceEqual: boolean;
  readonly secondsApart: number;
  readonly candidateCount: number;
}

export type SeparationReason =
  'no-candidate' | 'reference-mismatch' | 'balance-mismatch' | 'ambiguous-candidates';

export type MatchDecision =
  | { readonly kind: 'merge'; readonly into: TransactionId; readonly evidence: MatchEvidence }
  | { readonly kind: 'ask'; readonly candidate: TransactionId; readonly evidence: MatchEvidence }
  | { readonly kind: 'separate'; readonly reason: SeparationReason };

interface AssessedCandidate {
  readonly candidate: CandidateTransaction;
  readonly evidence: MatchEvidence;
  readonly veto: SeparationReason | null;
}

export function decideMatch(
  incoming: ObservationFacts,
  incomingAccountId: AccountId,
  candidates: readonly CandidateTransaction[],
): MatchDecision {
  const matched = candidates.filter((candidate) =>
    satisfiesHardCriteria(incoming, incomingAccountId, candidate),
  );

  // The count is recorded on every candidate's evidence, so a merge that happened
  // alongside look-alikes stays reviewable after the fact.
  const assessed = matched.map((candidate) => assess(incoming, candidate, matched.length));

  if (assessed.length === 0) return { kind: 'separate', reason: 'no-candidate' };

  const viable = assessed.filter((entry) => entry.veto === null);

  if (viable.length === 0) {
    // Every candidate was ruled out by positive counter-evidence. Report the strongest
    // reason rather than a generic miss: "these are different transactions" is a
    // materially different fact from "nothing looked similar".
    return { kind: 'separate', reason: strongestVeto(assessed) };
  }

  // Reference or balance equality identifies a transaction on its own, so a single
  // corroborated candidate is decisive even when weaker look-alikes exist alongside it.
  const corroborated = viable.filter(
    (entry) => entry.evidence.referenceEqual || entry.evidence.balanceEqual,
  );

  // Two independently corroborated candidates should be impossible. It means the
  // corroborating evidence is not as identifying as assumed, so trust none of it.
  if (corroborated.length > 1) return { kind: 'separate', reason: 'ambiguous-candidates' };

  const corroboratedMatch = soleEntry(corroborated);
  if (corroboratedMatch !== null) {
    return {
      kind: 'merge',
      into: corroboratedMatch.candidate.id,
      evidence: corroboratedMatch.evidence,
    };
  }

  // Amount and timing alone. One look-alike is a question worth asking; several are
  // indistinguishable, and guessing between them understates spending.
  const soleViable = soleEntry(viable);
  if (soleViable === null) return { kind: 'separate', reason: 'ambiguous-candidates' };

  return { kind: 'ask', candidate: soleViable.candidate.id, evidence: soleViable.evidence };
}

/** The one entry, or null if there is not exactly one. Keeps the caller free of index assertions. */
function soleEntry(entries: readonly AssessedCandidate[]): AssessedCandidate | null {
  return entries.length === 1 ? (entries[0] ?? null) : null;
}

/**
 * Criteria every candidate must satisfy before evidence is even weighed.
 *
 * Amounts must be **exactly** equal. Tolerance is the fastest route to an over-merge:
 * ₦5,000 and ₦5,050 are different transactions, and a product that treats them as
 * possibly-the-same will eventually hide one of them.
 */
function satisfiesHardCriteria(
  incoming: ObservationFacts,
  incomingAccountId: AccountId,
  candidate: CandidateTransaction,
): boolean {
  if (candidate.accountId !== incomingAccountId) return false;
  if (candidate.currency !== incoming.currency) return false;
  if (candidate.direction !== incoming.direction) return false;
  if (candidate.amountMinor !== incoming.amountMinor) return false;

  return millisecondsApart(incoming, candidate) <= windowFor(incoming, candidate);
}

function millisecondsApart(incoming: ObservationFacts, candidate: CandidateTransaction): number {
  return Math.abs(incoming.occurredAt.getTime() - candidate.occurredAt.getTime());
}

function windowFor(incoming: ObservationFacts, candidate: CandidateTransaction): number {
  const statementInvolved =
    incoming.source === 'STATEMENT' || candidate.sources.includes('STATEMENT');

  return statementInvolved ? STATEMENT_WINDOW_MS : ALERT_WINDOW_MS;
}

function assess(
  incoming: ObservationFacts,
  candidate: CandidateTransaction,
  candidateCount: number,
): AssessedCandidate {
  const reference = compareReferences(incoming, candidate);
  const balance = compareBalances(incoming, candidate);

  const evidence: MatchEvidence = {
    referenceEqual: reference === 'equal',
    balanceEqual: balance === 'equal',
    secondsApart: Math.round(millisecondsApart(incoming, candidate) / 1000),
    candidateCount,
  };

  const veto: SeparationReason | null =
    reference === 'different'
      ? 'reference-mismatch'
      : balance === 'different'
        ? 'balance-mismatch'
        : null;

  return { candidate, evidence, veto };
}

type Comparison = 'equal' | 'different' | 'unknown';

/**
 * A reference mismatch is a veto, not a demotion. Two entries the bank itself labelled
 * differently are different entries, however well amount and timing agree.
 */
function compareReferences(
  incoming: ObservationFacts,
  candidate: CandidateTransaction,
): Comparison {
  if (incoming.rawReference === null) return 'unknown';

  const known = candidate.references.map(normaliseReference).filter((value) => value.length > 0);
  if (known.length === 0) return 'unknown';

  return known.includes(normaliseReference(incoming.rawReference)) ? 'equal' : 'different';
}

/**
 * Case-folds, unlike the dedupe-key normaliser which deliberately preserves case.
 * References are opaque machine identifiers where case is presentational; narrations are
 * human text where it is not.
 */
function normaliseReference(value: string): string {
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

/** One transaction cannot leave two different balances behind it. */
function compareBalances(incoming: ObservationFacts, candidate: CandidateTransaction): Comparison {
  if (incoming.balanceAfterMinor === null || candidate.balanceAfterMinor === null) {
    return 'unknown';
  }

  return incoming.balanceAfterMinor === candidate.balanceAfterMinor ? 'equal' : 'different';
}

/**
 * Positive counter-evidence outranks a mere absence of corroboration, and a reference the
 * bank assigned is stronger than a balance reading that may describe a different concept
 * (available versus ledger balance).
 */
function strongestVeto(assessed: readonly AssessedCandidate[]): SeparationReason {
  const vetoes = assessed.map((entry) => entry.veto);
  if (vetoes.includes('reference-mismatch')) return 'reference-mismatch';
  if (vetoes.includes('balance-mismatch')) return 'balance-mismatch';
  return 'no-candidate';
}
