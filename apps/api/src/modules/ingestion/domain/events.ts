import type {
  AccountId,
  CurrencyCode,
  DeviceId,
  DomainEvent,
  InstitutionId,
  ObservationId,
} from '@atlas/shared-kernel';

/**
 * Ingestion emits observations; it never writes to the ledger (ARCHITECTURE §4).
 * The ledger decides what becomes a canonical transaction, which keeps admission
 * logic in one place and lets ingestion stay a dumb, testable parser.
 */

export const TRANSACTION_OBSERVED = 'ingestion.transaction_observed' as const;

export type ObservationSource = 'SMS' | 'EMAIL' | 'STATEMENT' | 'USER_STATED' | 'AGGREGATOR';

export interface TransactionObservedPayload {
  readonly observationId: ObservationId;
  readonly source: ObservationSource;
  readonly accountId: AccountId | null;
  readonly institutionId: InstitutionId | null;
  readonly deviceId: DeviceId | null;
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly occurredAt: string;
  /**
   * Balance the source reported after this movement. The reconciliation anchor:
   * it verifies ledger arithmetic and exposes gaps, so Atlas can say "I think I am
   * missing a transaction" instead of quietly reporting a wrong total.
   */
  readonly balanceAfterMinor: string | null;
  readonly description: string | null;
  /** Deterministic hash of source content — makes replayed sync idempotent. */
  readonly dedupeKey: string;
}

export type TransactionObservedEvent = DomainEvent<
  typeof TRANSACTION_OBSERVED,
  TransactionObservedPayload
>;

export const PARSE_FAILED = 'ingestion.parse_failed' as const;

export interface ParseFailedPayload {
  readonly institutionId: InstitutionId | null;
  readonly senderId: string;
  readonly channel: 'SMS' | 'EMAIL';
  readonly textHash: string;
  /** Present only when the user consented to upload this specific message (I4). */
  readonly redactedText: string | null;
}

export type ParseFailedEvent = DomainEvent<typeof PARSE_FAILED, ParseFailedPayload>;
