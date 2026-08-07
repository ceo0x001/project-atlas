import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './domain-event-bus';
import { OutboxWriter } from './outbox';
import { OutboxRelay } from './outbox-relay.service';

/**
 * Events — the seam between bounded contexts (ADR-002).
 *
 * Global because every context emits and consumes events; making each one import this
 * would be ceremony without a boundary behind it.
 *
 * `OutboxRelay` is exported so tests can drive a single drain deterministically instead of
 * waiting on its poll loop.
 */
@Global()
@Module({
  providers: [DomainEventBus, OutboxWriter, OutboxRelay],
  exports: [DomainEventBus, OutboxWriter, OutboxRelay],
})
export class EventsModule {}
