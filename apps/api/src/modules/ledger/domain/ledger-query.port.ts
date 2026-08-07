import type { UserId } from '@atlas/shared-kernel';
import type { LedgerQueryPlan, LedgerQueryResult } from './ledger-query';
import type { AccountBalance, TransactionView } from './types';

/**
 * The read side of the ledger — the only sanctioned path to financial numbers.
 * Implemented in infrastructure, consumed by the agent's tools.
 */
export interface LedgerQueryPort {
  /** Grouped aggregation: "how much did I spend on food last month, by week?" */
  aggregate(plan: LedgerQueryPlan): Promise<LedgerQueryResult>;

  /** Individual transactions matching a plan's filter, newest first. */
  listTransactions(plan: LedgerQueryPlan): Promise<readonly TransactionView[]>;

  /** Current balance per account, with the freshness of each. */
  getBalances(userId: UserId): Promise<readonly AccountBalance[]>;
}

export const LEDGER_QUERY_PORT = Symbol.for('atlas.LedgerQueryPort');
