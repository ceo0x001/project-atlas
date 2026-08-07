import { Module } from '@nestjs/common';
import { IdentityModule } from '@modules/identity';
import { DuplicateResolutionService } from './application/duplicate-resolution.service';
import { GapDetectionService } from './application/gap-detection.service';
import { ReconciliationService } from './application/reconciliation.service';
import { TransactionAdmissionService } from './application/transaction-admission.service';
import { LEDGER_QUERY_PORT } from './domain/ledger-query.port';
import { ReconciliationController } from './api/reconciliation.controller';
import { PrismaLedgerQueryRepository } from './infrastructure/prisma-ledger-query.repository';

/**
 * Ledger — the deterministic core (ARCHITECTURE §4).
 *
 * Owns accounts, transactions, balances, categories and merchants, and is the only
 * module permitted to perform money arithmetic. Admission happens here: `ingestion`
 * proposes observations, the ledger decides what becomes canonical.
 *
 * The read side is bound to its port so consumers depend on the interface, never on
 * Prisma. Reconciliation lives here too rather than in a module of its own: it decides
 * what a canonical transaction *is*, which is the ledger's own invariant, and a separate
 * module would need write access to these tables — the exact coupling the boundary rules
 * exist to prevent.
 */
@Module({
  // Needed for `DeviceAuthGuard` on the reconciliation surface: resolving the caller is
  // identity's job, and these endpoints change what money exists.
  imports: [IdentityModule],
  controllers: [ReconciliationController],
  providers: [
    { provide: LEDGER_QUERY_PORT, useClass: PrismaLedgerQueryRepository },
    ReconciliationService,
    DuplicateResolutionService,
    GapDetectionService,
    TransactionAdmissionService,
  ],
  exports: [LEDGER_QUERY_PORT],
})
export class LedgerModule {}
