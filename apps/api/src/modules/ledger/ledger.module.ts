import { Module } from '@nestjs/common';

/**
 * Ledger — the deterministic core (ARCHITECTURE §4).
 *
 * Owns accounts, transactions, balances, categories and merchants, and is the only
 * module permitted to perform money arithmetic. Admission of new transactions
 * happens here: `ingestion` proposes observations, the ledger decides what becomes
 * canonical.
 *
 * Implementations land in M1.
 */
@Module({})
export class LedgerModule {}
