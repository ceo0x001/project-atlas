import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type AccountId, newId, type TransactionId } from '@atlas/shared-kernel';
import { TRANSACTION_OBSERVED, type TransactionObservedEvent } from '@shared/events/contracts';
import { DomainEventBus, type DomainEventHandler } from '@shared/events/domain-event-bus';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';

/**
 * Admits observations into the books.
 *
 * This is the only place a canonical transaction is created. Ingestion records what a
 * source claimed; the ledger decides what is true.
 *
 * **M1 scope: one observation becomes one transaction.** SMS is the only live source,
 * so there is nothing to reconcile against yet. Multi-source matching — the same
 * purchase seen as an SMS alert and again as a statement row, collapsed into one
 * transaction using the reported balance as an anchor — is M2 (ARCHITECTURE §5.1).
 * The observation/transaction split already exists precisely so that arrives without
 * reshaping anything.
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
  ) {}

  onModuleInit(): void {
    this.eventBus.register(this);
  }

  async handle(event: TransactionObservedEvent): Promise<void> {
    const { payload } = event;

    await this.tenantScope.run(event.userId, async (tx) => {
      const observation = await tx.transactionObservation.findUnique({
        where: { id: payload.observationId },
        select: { transactionId: true },
      });

      if (!observation) {
        // The event is durable but its subject is gone — a genuine inconsistency,
        // not a retryable blip, so it is worth shouting about.
        throw new Error(`Observation ${payload.observationId} not found`);
      }

      // Idempotency. Delivery is at-least-once, so a redelivered event must be a
      // no-op rather than a second transaction for the same money.
      if (observation.transactionId !== null) return;

      const transactionId = newId<'TransactionId'>();
      const occurredAt = new Date(payload.occurredAt);
      const balanceAfter =
        payload.balanceAfterMinor === null ? null : BigInt(payload.balanceAfterMinor);

      await tx.transaction.create({
        data: {
          id: transactionId,
          userId: event.userId,
          accountId: payload.accountId,
          amountMinor: BigInt(payload.amountMinor),
          currency: payload.currency,
          direction: payload.direction,
          occurredAt,
          description: payload.description ?? 'Unlabelled transaction',
          balanceAfterMinor: balanceAfter,
          status: 'POSTED',
        },
      });

      // The link is what makes the number explainable (invariant I6): every
      // transaction can name the observations it was assembled from.
      await tx.transactionObservation.update({
        where: { id: payload.observationId },
        data: { transactionId },
      });

      if (balanceAfter !== null) {
        await this.applyBalanceAnchor(tx, payload.accountId, balanceAfter, occurredAt);
      }

      this.logger.debug(`Admitted observation ${payload.observationId} as ${transactionId}`);

      return transactionId as TransactionId;
    });
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
