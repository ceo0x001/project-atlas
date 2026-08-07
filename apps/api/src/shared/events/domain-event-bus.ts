import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, EventId } from '@atlas/shared-kernel';

/**
 * In-process domain event bus (ADR-002).
 *
 * This is the seam between bounded contexts. `ingestion` never calls into `ledger`;
 * it emits a `TransactionObserved` event and the ledger decides what to do with it.
 * The lint rules enforce that separation, and this class is what makes it workable.
 *
 * Delivery is at-least-once by design, so handlers must be idempotent. Events are
 * persisted to the outbox in the same transaction as the state change that produced
 * them, then dispatched here; a handler that throws leaves its outbox row
 * unpublished for a future relay to retry rather than losing the event.
 *
 * Dispatch happens immediately after commit so an alert appears without waiting on a
 * poll, and `OutboxRelay` retries anything that failed or never ran. An event can
 * therefore be delivered twice, which is why handlers must be idempotent rather than
 * merely tolerant.
 */

export interface DomainEventHandler<TEvent extends DomainEvent = DomainEvent> {
  readonly eventType: string;
  handle(event: TEvent): Promise<void>;
}

export interface DispatchOutcome {
  readonly published: readonly EventId[];
  readonly failed: readonly { readonly eventId: EventId; readonly reason: string }[];
}

@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  register(handler: DomainEventHandler): void {
    const existing = this.handlers.get(handler.eventType) ?? [];
    existing.push(handler);
    this.handlers.set(handler.eventType, existing);
  }

  /**
   * Dispatches events and reports which ones every handler accepted.
   *
   * One event's failure never blocks another's: each is isolated so a single bad
   * message cannot stall a whole sync batch.
   */
  async dispatch(events: readonly DomainEvent[]): Promise<DispatchOutcome> {
    const published: EventId[] = [];
    const failed: { eventId: EventId; reason: string }[] = [];

    for (const event of events) {
      const handlers = this.handlers.get(event.type) ?? [];

      if (handlers.length === 0) {
        // Not an error: an event with no consumer yet is still durably recorded.
        published.push(event.id);
        continue;
      }

      try {
        for (const handler of handlers) {
          await handler.handle(event);
        }
        published.push(event.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Handler failed for ${event.type} (${event.id}): ${reason}`);
        failed.push({ eventId: event.id, reason });
      }
    }

    return { published, failed };
  }
}
