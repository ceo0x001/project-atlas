import { Injectable, Logger } from '@nestjs/common';
import {
  type AccountId,
  type CurrencyCode,
  isCurrencyCode,
  newId,
  type ObservationId,
  type TransactionId,
  type UserId,
} from '@atlas/shared-kernel';
import type { TenantClient } from '@shared/prisma/tenant-scope';
import {
  ALERT_WINDOW_MS,
  type CandidateTransaction,
  decideMatch,
  type MatchDecision,
  STATEMENT_WINDOW_MS,
} from '../domain/reconciliation/match-decision';
import type { ObservationFacts } from '../domain/reconciliation/observation-facts';
import {
  type ObservationSet,
  projectTransaction,
} from '../domain/reconciliation/transaction-projection';

/**
 * Turns a reconciliation decision into database effects (ADR-008).
 *
 * The decision itself is made by pure functions in `domain/reconciliation`; this class
 * only persists their consequences. Keeping the split sharp is what lets the rules that
 * decide what money exists be tested exhaustively without a database, and it means this
 * file contains no matching logic to disagree with them.
 *
 * Every method here takes an existing `TenantClient`, so reconciliation always runs inside
 * the caller's transaction. That is not incidental: attaching an observation and
 * re-projecting the transaction it now belongs to must be atomic, or a crash between the
 * two leaves a transaction whose figures contradict its own evidence.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * Decides what an incoming observation belongs to.
   *
   * Candidates are narrowed in SQL by the hard criteria that cannot be relaxed — same
   * account, currency, direction, and an *exact* amount — then the domain applies the
   * windows and vetoes. The SQL half is a performance filter only; loosening it could
   * never cause a wrong merge, because `decideMatch` re-checks everything it relies on.
   */
  async decide(
    tx: TenantClient,
    userId: UserId,
    observation: ObservationFacts,
    accountId: AccountId,
  ): Promise<MatchDecision> {
    const candidates = await this.findCandidates(tx, userId, observation, accountId);
    return decideMatch(observation, accountId, candidates);
  }

  /**
   * Attaches an observation to an existing transaction and re-projects it.
   *
   * The transaction's fields are recomputed from its whole observation set rather than
   * patched from the newcomer, so the result depends only on the evidence and not on
   * arrival order (ADR-008).
   */
  async attach(
    tx: TenantClient,
    userId: UserId,
    observationId: ObservationId,
    transactionId: TransactionId,
  ): Promise<void> {
    await tx.transactionObservation.update({
      where: { id: observationId },
      data: { transactionId },
    });

    await this.reproject(tx, userId, transactionId);
  }

  /**
   * Recomputes a transaction's canonical fields from its observations.
   *
   * Safe to call repeatedly: it is a projection, so running it twice yields the same row.
   */
  async reproject(tx: TenantClient, userId: UserId, transactionId: TransactionId): Promise<void> {
    const observations = await this.loadObservations(tx, transactionId);

    if (observations === null) {
      // A transaction with no observations cannot be projected and should not exist. Left
      // alone and shouted about rather than deleted: silently removing a row that some
      // insight may cite would trade a visible inconsistency for an invisible one.
      this.logger.error(`Transaction ${transactionId} has no observations; cannot re-project`);
      return;
    }

    const fields = projectTransaction(observations);

    await tx.transaction.update({
      where: { id: transactionId },
      data: {
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        direction: fields.direction,
        occurredAt: fields.occurredAt,
        description: fields.description,
        balanceAfterMinor: fields.balanceAfterMinor,
      },
    });

    if (fields.conflicts.length > 0) {
      // Sources disagreeing about how much money moved means a bad parse or a wrong
      // merge. Recorded at warn level because it is actionable, not routine.
      this.logger.warn(
        `Transaction ${transactionId} projected with conflicts: ${JSON.stringify(fields.conflicts)}`,
      );
    }
  }

  /**
   * Records that one transaction absorbed another.
   *
   * The absorbed transaction is superseded, never deleted: insights, memories and past
   * explanations may already cite its id, and every aggregate excludes superseded rows in
   * the query compiler's mandatory predicate set.
   */
  async merge(
    tx: TenantClient,
    userId: UserId,
    survivingId: TransactionId,
    absorbedId: TransactionId,
    evidence: unknown,
  ): Promise<void> {
    await tx.transactionObservation.updateMany({
      where: { transactionId: absorbedId },
      data: { transactionId: survivingId },
    });

    await tx.transaction.update({
      where: { id: absorbedId },
      data: { supersededByTransactionId: survivingId },
    });

    await this.reproject(tx, userId, survivingId);

    await this.recordEvent(tx, userId, {
      kind: 'MERGE',
      decidedBy: 'SYSTEM',
      survivingTransactionId: survivingId,
      absorbedTransactionId: absorbedId,
      evidence,
    });
  }

  /**
   * Queues two transactions as a possible duplicate for the user to answer.
   *
   * The pair is keyed in id order so the same two transactions cannot be queued twice from
   * opposite directions — the unique constraint depends on that ordering, and without it a
   * user would be asked the same question repeatedly.
   */
  async queueSuspectedDuplicate(
    tx: TenantClient,
    userId: UserId,
    a: TransactionId,
    b: TransactionId,
    evidence: unknown,
  ): Promise<void> {
    const [left, right] = a < b ? [a, b] : [b, a];

    await tx.suspectedDuplicate.upsert({
      where: {
        userId_leftTransactionId_rightTransactionId: {
          userId,
          leftTransactionId: left,
          rightTransactionId: right,
        },
      },
      // Already asked. Re-asserting the evidence would reopen a question the user may
      // have already answered.
      update: {},
      create: {
        id: newId<'InsightId'>(),
        userId,
        leftTransactionId: left,
        rightTransactionId: right,
        evidence: evidence as never,
      },
    });
  }

  private async recordEvent(
    tx: TenantClient,
    userId: UserId,
    event: {
      kind: 'MERGE' | 'SPLIT' | 'GAP_FLAGGED';
      decidedBy: 'SYSTEM' | 'USER';
      survivingTransactionId?: TransactionId | null;
      absorbedTransactionId?: TransactionId | null;
      evidence: unknown;
    },
  ): Promise<void> {
    await tx.reconciliationEvent.create({
      data: {
        id: newId<'EventId'>(),
        userId,
        kind: event.kind,
        decidedBy: event.decidedBy,
        survivingTransactionId: event.survivingTransactionId ?? null,
        absorbedTransactionId: event.absorbedTransactionId ?? null,
        evidence: event.evidence as never,
      },
    });
  }

  /**
   * Candidate transactions that could be the same money.
   *
   * The time bound uses the wider of the two windows, because which one applies depends on
   * the *candidate's* sources — known only after loading it. Over-fetching here is free;
   * the domain narrows it correctly.
   */
  private async findCandidates(
    tx: TenantClient,
    userId: UserId,
    observation: ObservationFacts,
    accountId: AccountId,
  ): Promise<readonly CandidateTransaction[]> {
    const widestWindow = Math.max(STATEMENT_WINDOW_MS, ALERT_WINDOW_MS);
    const from = new Date(observation.occurredAt.getTime() - widestWindow);
    const to = new Date(observation.occurredAt.getTime() + widestWindow);

    const rows = await tx.transaction.findMany({
      where: {
        userId,
        accountId,
        currency: observation.currency,
        direction: observation.direction,
        amountMinor: observation.amountMinor,
        occurredAt: { gte: from, lte: to },
        status: 'POSTED',
        // A superseded transaction is not a merge target; its observations already moved
        // to the survivor, so matching against it would resurrect a resolved duplicate.
        supersededByTransactionId: null,
      },
      select: {
        id: true,
        accountId: true,
        amountMinor: true,
        currency: true,
        direction: true,
        occurredAt: true,
        balanceAfterMinor: true,
        observations: { select: { source: true, rawReference: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id as TransactionId,
      accountId: row.accountId as AccountId,
      amountMinor: row.amountMinor,
      currency: row.currency as CurrencyCode,
      direction: row.direction,
      occurredAt: row.occurredAt,
      balanceAfterMinor: row.balanceAfterMinor,
      references: row.observations
        .map((linked) => linked.rawReference)
        .filter((reference): reference is string => reference !== null),
      sources: row.observations.map((linked) => linked.source),
    }));
  }

  /** Null when the transaction has no observations, which the projection cannot represent. */
  private async loadObservations(
    tx: TenantClient,
    transactionId: TransactionId,
  ): Promise<ObservationSet | null> {
    const rows = await tx.transactionObservation.findMany({
      where: { transactionId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        source: true,
        amountMinor: true,
        currency: true,
        direction: true,
        occurredAt: true,
        balanceAfterMinor: true,
        description: true,
        rawReference: true,
        observedAt: true,
      },
    });

    const facts: ObservationFacts[] = rows.flatMap((row) => {
      if (!isCurrencyCode(row.currency)) {
        // Unreachable through the sync API, which validates the currency. Skipped rather
        // than thrown so one bad row cannot make a transaction unprojectable forever.
        this.logger.error(`Observation ${row.id} has unknown currency '${row.currency}'`);
        return [];
      }

      return [
        {
          id: row.id as ObservationId,
          source: row.source,
          amountMinor: row.amountMinor,
          currency: row.currency,
          direction: row.direction,
          occurredAt: row.occurredAt,
          balanceAfterMinor: row.balanceAfterMinor,
          description: row.description,
          rawReference: row.rawReference,
          observedAt: row.observedAt,
        },
      ];
    });

    const [first, ...rest] = facts;
    return first === undefined ? null : [first, ...rest];
  }
}
