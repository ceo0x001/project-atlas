import { Module } from '@nestjs/common';

/**
 * Intelligence — categorisation, recurring-payment detection, anomalies, insights.
 *
 * Reads the ledger, never mutates it. Every insight it produces must carry
 * evidence linking back to the transactions that justify it (invariant I6);
 * an insight that cannot explain itself is a bug, not a feature.
 *
 * Implementations land in M4.
 */
@Module({})
export class IntelligenceModule {}
