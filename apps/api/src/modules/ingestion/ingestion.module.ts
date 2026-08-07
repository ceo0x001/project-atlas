import { Module } from '@nestjs/common';

/**
 * Ingestion — SMS/email parse templates, statement imports, deduplication.
 *
 * Emits `TransactionObserved` events and never writes to the ledger directly, so
 * admission rules stay in one place and this module remains a pure, testable
 * parsing pipeline.
 *
 * Implementations land in M1 (SMS) and M2 (statements, reconciliation).
 */
@Module({})
export class IngestionModule {}
