import type {
  AccountId,
  CurrencyCode,
  DeviceId,
  DomainEvent,
  InstitutionId,
  ObservationId,
} from '@atlas/shared-kernel';

/**
 * Cross-context event contracts.
 *
 * These live in `shared` rather than inside the publishing module on purpose. An
 * event is the shared language between two bounded contexts, so it belongs to
 * neither: if `ingestion` owned `TransactionObserved`, then `ledger` would have to
 * import `ingestion` to consume it, and the dependency the event exists to avoid
 * would reappear through the back door.
 *
 * Payloads carry primitives only — amounts as decimal strings, timestamps as ISO
 * strings — because these are serialised through the outbox and must survive a
 * round trip through JSON unchanged. A BigInt would not.
 */

export const TRANSACTION_OBSERVED = 'ingestion.transaction_observed' as const;

export type ObservationSource = 'SMS' | 'EMAIL' | 'STATEMENT' | 'USER_STATED' | 'AGGREGATOR';

export interface TransactionObservedPayload {
  readonly observationId: ObservationId;
  readonly source: ObservationSource;
  readonly accountId: AccountId;
  readonly institutionId: InstitutionId | null;
  readonly deviceId: DeviceId | null;
  /** Unsigned magnitude in minor units; `direction` carries the sign. */
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly occurredAt: string;
  /**
   * Balance the source reported after this movement. The reconciliation anchor: it
   * lets the ledger verify its own arithmetic and detect gaps, so Atlas can say
   * "I think I am missing a transaction" instead of quietly reporting a wrong total.
   */
  readonly balanceAfterMinor: string | null;
  readonly description: string | null;
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
