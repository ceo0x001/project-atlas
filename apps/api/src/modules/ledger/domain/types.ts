import type {
  AccountId,
  CategoryId,
  CurrencyCode,
  MerchantId,
  Money,
  TransactionId,
} from '@atlas/shared-kernel';

/**
 * Ledger domain types.
 *
 * Deliberately independent of Prisma: the ORM is an implementation detail behind
 * the repository, and the domain should be describable without it. Mapping happens
 * once, in the infrastructure layer.
 */

export type TransactionDirection = 'DEBIT' | 'CREDIT';

export type TransactionStatus = 'PENDING' | 'POSTED' | 'REVERSED';

export type CategorySource = 'RULE' | 'MODEL' | 'USER';

export interface TransactionView {
  readonly id: TransactionId;
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly direction: TransactionDirection;
  readonly occurredAt: Date;
  readonly description: string;
  readonly categoryId: CategoryId | null;
  readonly merchantId: MerchantId | null;
  readonly balanceAfter: Money | null;
  readonly status: TransactionStatus;
}

export interface AccountBalance {
  readonly accountId: AccountId;
  readonly label: string;
  readonly currency: CurrencyCode;
  readonly balance: Money;
  /**
   * When this balance was last corroborated by a source. A stale balance is not a
   * wrong balance, but the assistant must be able to say how fresh it is rather
   * than implying real-time certainty.
   */
  readonly asOf: Date | null;
}
