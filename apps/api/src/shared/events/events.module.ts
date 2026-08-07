import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './domain-event-bus';
import { OutboxWriter } from './outbox';

@Global()
@Module({
  providers: [DomainEventBus, OutboxWriter],
  exports: [DomainEventBus, OutboxWriter],
})
export class EventsModule {}
