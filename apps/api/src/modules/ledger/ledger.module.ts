import { Module } from '@nestjs/common';
import { LEDGER_QUERY_PORT } from './domain/ledger-query.port';
import { PrismaLedgerQueryRepository } from './infrastructure/prisma-ledger-query.repository';

/**
 * Ledger — the deterministic core (ARCHITECTURE §4).
 *
 * Owns accounts, transactions, balances, categories and merchants, and is the only
 * module permitted to perform money arithmetic. Admission of new transactions
 * happens here: `ingestion` proposes observations, the ledger decides what becomes
 * canonical.
 *
 * The read side is bound to its port so consumers depend on the interface, never on
 * Prisma. The write side lands with reconciliation in M2.
 */
@Module({
  providers: [{ provide: LEDGER_QUERY_PORT, useClass: PrismaLedgerQueryRepository }],
  exports: [LEDGER_QUERY_PORT],
})
export class LedgerModule {}
