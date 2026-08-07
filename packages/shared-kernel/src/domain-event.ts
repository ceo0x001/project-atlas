import type { EventId, UserId } from './id';

/**
 * Domain events are how bounded contexts talk to each other (ADR-002).
 *
 * They are persisted through a transactional outbox in the same transaction that
 * changes state, so "state changed" and "event emitted" can never disagree. That
 * outbox is also the seam along which a module becomes a separate service later,
 * which is why the contract is deliberately transport-agnostic.
 */
export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  readonly id: EventId;
  readonly type: TType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Every event belongs to exactly one user — the tenant boundary is absolute. */
  readonly userId: UserId;
  readonly payload: TPayload;
  readonly occurredAt: Date;
  /** Bump when `payload` changes incompatibly; consumers branch on this. */
  readonly schemaVersion: number;
}

/** Persisted outbox row. `publishedAt` is null until a relay has dispatched it. */
export interface OutboxRecord {
  readonly id: EventId;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly userId: UserId;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly schemaVersion: number;
  readonly publishedAt: Date | null;
  readonly attempts: number;
}

/**
 * Port for emitting events. Implementations must enlist in the caller's database
 * transaction — an event published outside the transaction that produced it is a
 * lie waiting to happen.
 */
export interface EventPublisher {
  publish<TType extends string, TPayload>(event: DomainEvent<TType, TPayload>): Promise<void>;
  publishAll(events: readonly DomainEvent[]): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol.for('atlas.EventPublisher');

/** Handler port. Handlers must be idempotent: at-least-once delivery is the contract. */
export interface EventHandler<TEvent extends DomainEvent = DomainEvent> {
  readonly eventType: TEvent['type'];
  handle(event: TEvent): Promise<void>;
}
