import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type AccountId,
  isCurrencyCode,
  newId,
  type ObservationId,
  type TransactionId,
} from '@atlas/shared-kernel';
import { TRANSACTION_OBSERVED, type TransactionObservedEvent } from '@shared/events/contracts';
import { DomainEventBus, type DomainEventHandler } from '@shared/events/domain-event-bus';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import type { ObservationFacts } from '../domain/reconciliation/observation-facts';
import { ObservationAlreadyAdmitted, ReconciliationService } from './reconciliation.service';

/**
 * Admits observations into the books.
 *
 * This is the only place a canonical transaction is created. Ingestion records what a
 * source claimed; the ledger decides what is true.
 *
 * Admission stays **eager** — an observation becomes a transaction within seconds,
 * because the product promise is that Atlas knows about a purchase almost as it happens.
 * Holding observations until a matching window closes would buy easier matching and cost
 * the thing that makes the product feel alive (ADR-008).
 *
 * The consequence is that reconciliation cannot be a gate in front of admission. By the
 * time a statement row arrives describing a purchase already known from SMS, the
 * transaction exists — so each observation asks `decideMatch` whether it belongs to
 * something already booked, and only creates when the answer is no.
 */
@Injectable()
export class TransactionAdmissionService
  implements DomainEventHandler<TransactionObservedEvent>, OnModuleInit
{
  readonly eventType = TRANSACTION_OBSERVED;

  private readonly logger = new Logger(TransactionAdmissionService.name);

  constructor(
    private readonly tenantScope: TenantScope,
    private readonly eventBus: DomainEventBus,
    private readonly reconciliation: ReconciliationService,
  ) {}

  onModuleInit(): void {
    this.eventBus.register(this);
  }

  async handle(event: TransactionObservedEvent): Promise<void> {
    try {
      await this.admit(event);
    } catch (error) {
      // Losing the race is the expected outcome for one of two concurrent handlers, and the
      // winner has already done the work. Anything else is a real failure and must propagate so
      // the outbox retries it.
      if (error instanceof ObservationAlreadyAdmitted) {
        this.logger.debug(error.message);
        return;
      }

      throw error;
    }
  }

  private async admit(event: TransactionObservedEvent): Promise<void> {
    const { payload } = event;

    await this.tenantScope.run(event.userId, async (tx) => {
      const stored = await tx.transactionObservation.findUnique({
        where: { id: payload.observationId },
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
          transactionId: true,
        },
      });

      if (!stored) {
        // The event is durable but its subject is gone — a genuine inconsistency,
        // not a retryable blip, so it is worth shouting about.
        throw new Error(`Observation ${payload.observationId} not found`);
      }

      // A cheap short-circuit for the common redelivery, not the guarantee. Two handlers can
      // both pass this check — the in-process dispatch races the outbox relay — so the real
      // protection is the conditional claim below, which Postgres arbitrates.
      if (stored.transactionId !== null) return;

      if (!isCurrencyCode(stored.currency)) {
        throw new Error(`Observation ${stored.id} has unknown currency '${stored.currency}'`);
      }

      // Facts are read from the row rather than the event payload. The database is the
      // source of truth; the payload is a lossy projection of it that predates
      // reconciliation and carries no reference.
      const facts: ObservationFacts = {
        id: stored.id as ObservationId,
        source: stored.source,
        amountMinor: stored.amountMinor,
        currency: stored.currency,
        direction: stored.direction,
        occurredAt: stored.occurredAt,
        balanceAfterMinor: stored.balanceAfterMinor,
        description: stored.description,
        rawReference: stored.rawReference,
        observedAt: stored.observedAt,
      };

      const decision = await this.reconciliation.decide(tx, event.userId, facts, payload.accountId);

      const transactionId =
        decision.kind === 'merge'
          ? await this.absorbInto(tx, event, facts, decision.into)
          : await this.createTransaction(tx, event, facts, payload.accountId);

      // A single look-alike on amount and timing alone is a question, not a decision.
      // Asked rather than guessed, because silently reshaping someone's financial history
      // on circumstantial evidence is what would make a CFO untrustworthy (ADR-008 §4).
      if (decision.kind === 'ask') {
        await this.reconciliation.queueSuspectedDuplicate(
          tx,
          event.userId,
          transactionId,
          decision.candidate,
          decision.evidence,
        );
      }

      if (facts.balanceAfterMinor !== null) {
        await this.applyBalanceAnchor(
          tx,
          payload.accountId,
          facts.balanceAfterMinor,
          facts.occurredAt,
        );
      }

      return transactionId;
    });
  }

  /**
   * Attaches the observation to a transaction that already describes this money.
   *
   * No new transaction is created, and the survivor is re-projected from its whole
   * observation set rather than patched — so the result depends on the evidence, not on
   * which source happened to arrive first.
   */
  private async absorbInto(
    tx: TenantClient,
    event: TransactionObservedEvent,
    facts: ObservationFacts,
    into: TransactionId,
  ): Promise<TransactionId> {
    await this.reconciliation.attach(tx, event.userId, facts.id, into);

    this.logger.debug(`Observation ${facts.id} reconciled into existing ${into}`);

    return into;
  }

  private async createTransaction(
    tx: TenantClient,
    event: TransactionObservedEvent,
    facts: ObservationFacts,
    accountId: AccountId,
  ): Promise<TransactionId> {
    const transactionId = newId<'TransactionId'>();

    await tx.transaction.create({
      data: {
        id: transactionId,
        userId: event.userId,
        accountId,
        amountMinor: facts.amountMinor,
        currency: facts.currency,
        direction: facts.direction,
        occurredAt: facts.occurredAt,
        description: facts.description ?? 'Unlabelled transaction',
        balanceAfterMinor: facts.balanceAfterMinor,
        status: 'POSTED',
      },
    });

    // The link is what makes the number explainable (invariant I6): every transaction can name
    // the observations it was assembled from. Claimed conditionally, so if another handler got
    // there first this throws and the transaction created just above is rolled back with it —
    // otherwise it would survive as an orphan that no observation explains but every total counts.
    await this.reconciliation.claimObservation(tx, facts.id, transactionId);

    this.logger.debug(`Admitted observation ${facts.id} as ${transactionId}`);

    return transactionId;
  }

  /**
   * Updates the cached account balance from the balance a bank reported.
   *
   * Guarded on `balanceAsOf` so a late-arriving older alert cannot overwrite a newer
   * balance — devices sync out of order after being offline, and "most recently
   * received" is not "most recent". The comparison lives in the WHERE clause so it
   * is atomic rather than read-then-write.
   */
  private async applyBalanceAnchor(
    tx: TenantClient,
    accountId: AccountId,
    balanceMinor: bigint,
    asOf: Date,
  ): Promise<void> {
    await tx.account.updateMany({
      where: {
        id: accountId,
        OR: [{ balanceAsOf: null }, { balanceAsOf: { lt: asOf } }],
      },
      data: { currentBalanceMinor: balanceMinor, balanceAsOf: asOf },
    });
  }
}
