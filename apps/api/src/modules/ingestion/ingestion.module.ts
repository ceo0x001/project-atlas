import { Module } from '@nestjs/common';
import { IdentityModule } from '@modules/identity';
import { SyncController } from './api/sync.controller';
import { ObservationIntakeService } from './application/observation-intake.service';

/**
 * Ingestion — SMS/email parse templates, statement imports, deduplication.
 *
 * Emits `TransactionObserved` events and never writes to the ledger directly, so
 * admission rules stay in one place and this module remains a pure, testable
 * parsing pipeline.
 *
 * Statement import and the template-synthesis flywheel land in M2.
 */
@Module({
  imports: [IdentityModule],
  controllers: [SyncController],
  providers: [ObservationIntakeService],
  exports: [ObservationIntakeService],
})
export class IngestionModule {}
