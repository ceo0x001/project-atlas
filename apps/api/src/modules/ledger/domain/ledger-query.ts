import type {
  AccountId,
  CategoryId,
  CurrencyCode,
  MerchantId,
  Money,
  TransactionId,
  UserId,
} from '@atlas/shared-kernel';
import type { TransactionDirection } from './types';

/**
 * The typed query plan — the contract that keeps the assistant honest.
 *
 * The model never writes SQL and never adds up numbers. It emits one of these
 * plans; the ledger validates it and compiles it to parameterised SQL; the numbers
 * that come back are the only numbers the model is permitted to state (ADR-005).
 * That is what makes "the database is the source of truth" structural rather than
 * a prompt instruction the model may ignore under pressure.
 */

export type LedgerGroupBy =
  'category' | 'merchant' | 'account' | 'direction' | 'day' | 'week' | 'month';

export type LedgerMetric = 'total' | 'count' | 'average' | 'min' | 'max';

export interface LedgerFilter {
  readonly accountIds?: readonly AccountId[];
  readonly categoryIds?: readonly CategoryId[];
  readonly merchantIds?: readonly MerchantId[];
  readonly direction?: TransactionDirection;
  /** Aggregation happens within one currency; mixing requires an explicit, dated rate. */
  readonly currency: CurrencyCode;
  readonly occurredFrom: Date;
  readonly occurredTo: Date;
  readonly minAmount?: Money;
  readonly maxAmount?: Money;
  /** Free-text match against description/narration. */
  readonly search?: string;
}

export interface LedgerQueryPlan {
  readonly userId: UserId;
  readonly filter: LedgerFilter;
  readonly groupBy?: readonly LedgerGroupBy[];
  readonly metrics: readonly LedgerMetric[];
  readonly sort?: { readonly by: LedgerMetric; readonly direction: 'asc' | 'desc' };
  readonly limit?: number;
}

export interface LedgerAggregateRow {
  /** Group key values, keyed by the groupBy dimension that produced them. */
  readonly key: Partial<Record<LedgerGroupBy, string>>;
  readonly total: Money;
  readonly count: number;
  readonly average: Money | null;
  readonly min: Money | null;
  readonly max: Money | null;
}

export interface LedgerQueryResult {
  readonly rows: readonly LedgerAggregateRow[];
  readonly currency: CurrencyCode;
  readonly window: { readonly from: Date; readonly to: Date };
  /**
   * Ids of the transactions behind this result (invariant I6). The canvas renders
   * from these, and a user can always drill from a number to its evidence.
   */
  readonly provenance: readonly TransactionId[];
  readonly generatedAt: Date;
  /**
   * True when the result excludes data we know is missing — for example a detected
   * balance discontinuity in the window. The assistant must disclose this rather
   * than presenting a confident total over incomplete data.
   */
  readonly hasKnownGaps: boolean;
}
