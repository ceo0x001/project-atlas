import type { CategoryId, MerchantId, UserId } from '@atlas/shared-kernel';
import type { LedgerQueryPlan, LedgerQueryResult } from './ledger-query';
import type { AccountBalance, TransactionView } from './types';

export interface CategoryRef {
  readonly id: CategoryId;
  readonly slug: string;
  readonly name: string;
}

export interface MerchantRef {
  readonly id: MerchantId;
  readonly displayName: string;
}

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

  /**
   * Resolves a category the user named in words to its identifier.
   *
   * Exists so the model never has to produce an opaque id. Asking a language model
   * for a ULID it has never seen is an invitation to invent one; naming "food" and
   * having the ledger resolve it means an unknown category comes back as `null` and
   * the assistant says so, instead of silently answering about everything.
   */
  findCategory(userId: UserId, term: string): Promise<CategoryRef | null>;

  /** As `findCategory`, for merchants. */
  findMerchant(userId: UserId, term: string): Promise<MerchantRef | null>;
}

export const LEDGER_QUERY_PORT = Symbol.for('atlas.LedgerQueryPort');
