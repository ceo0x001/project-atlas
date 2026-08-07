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
import { installBigIntSerializer } from './shared/serialization/bigint';

/**
 * The modular monolith (ADR-002). One deployable, eight bounded contexts, with the
 * dependency graph between them enforced by lint rather than convention.
 *
 * The BigInt serializer is installed here rather than only in `main.ts`. Money is BigInt
 * throughout, so any response carrying an amount throws `Do not know how to serialize a
 * BigInt` without it — and installing it in the entry point alone meant the guarantee held for
 * the deployed process but not for anything else that boots the app, including every
 * integration test. A safety property that depends on which file started the process is not a
 * safety property; module load is the earliest point every consumer shares.
 */
installBigIntSerializer();

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
