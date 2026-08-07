import { Module } from '@nestjs/common';
import { IdentityModule } from '@modules/identity';
import { StatementController } from './api/statement.controller';
import { SyncController } from './api/sync.controller';
import { ObservationIntakeService } from './application/observation-intake.service';
import { StatementImportService } from './application/statement-import.service';

/**
 * Ingestion — SMS/email parse templates, statement imports, deduplication.
 *
 * Emits `TransactionObserved` events and never writes to the ledger directly, so
 * admission rules stay in one place and this module remains a pure, testable
 * parsing pipeline. Statement rows go through exactly that path, which is why an
 * uploaded row describing a purchase already known from an SMS alert is reconciled
 * into it rather than double-counted — nothing here has to know about matching.
 *
 * The template-synthesis flywheel (ADR-004) is still outstanding.
 */
@Module({
  imports: [IdentityModule],
  controllers: [SyncController, StatementController],
  providers: [ObservationIntakeService, StatementImportService],
  exports: [ObservationIntakeService, StatementImportService],
})
export class IngestionModule {}
