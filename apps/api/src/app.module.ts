import { Module } from '@nestjs/common';
import { ConfigModule } from '@config/config.module';
import { HealthModule } from './health/health.module';
import { ConversationModule } from '@modules/conversation';
import { IdentityModule } from '@modules/identity';
import { IngestionModule } from '@modules/ingestion';
import { IntelligenceModule } from '@modules/intelligence';
import { LedgerModule } from '@modules/ledger';
import { MemoryModule } from '@modules/memory';
import { NotificationsModule } from '@modules/notifications';
import { VoiceModule } from '@modules/voice';
import { EventsModule } from '@shared/events/events.module';
import { PrismaModule } from '@shared/prisma/prisma.module';

/**
 * The modular monolith (ADR-002). One deployable, eight bounded contexts, with the
 * dependency graph between them enforced by lint rather than convention.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventsModule,
    HealthModule,

    IdentityModule,
    LedgerModule,
    IngestionModule,
    IntelligenceModule,
    MemoryModule,
    ConversationModule,
    VoiceModule,
    NotificationsModule,
  ],
})
export class AppModule {}
