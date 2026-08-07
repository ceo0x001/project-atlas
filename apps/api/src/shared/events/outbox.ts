import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventId } from '@atlas/shared-kernel';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { TenantClient } from '@shared/prisma/tenant-scope';

/**
 * Transactional outbox (ADR-002).
 *
 * Events are written using the caller's transaction handle, never a fresh
 * connection. That is the entire point: "the state changed" and "an event was
 * emitted" commit together or not at all. Publishing outside the producing
 * transaction would eventually mean an event describing a transaction that got
 * rolled back — a lie the rest of the system would faithfully act on.
 */
@Injectable()
export class OutboxWriter {
  constructor(private readonly prisma: PrismaService) {}

  /** Must be called with the transaction that is making the state change. */
  async append(tx: TenantClient, events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    await tx.outboxEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        userId: event.userId,
        payload: event.payload as never,
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt,
      })),
    });
  }

  /** Marks events a handler has accepted. Unpublished rows are the retry backlog. */
  async markPublished(eventIds: readonly EventId[]): Promise<void> {
    if (eventIds.length === 0) return;

    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: [...eventIds] } },
      data: { publishedAt: new Date() },
    });
  }

  /** Records a delivery failure so the backlog carries why, not just that. */
  async recordFailure(eventId: EventId, reason: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: { attempts: { increment: 1 }, lastError: reason.slice(0, 1_000) },
    });
  }
}
