import { isUlid } from '@atlas/shared-kernel';
import { z } from 'zod';

/**
 * Wire contract for device sync.
 *
 * The device parses SMS locally and posts *structured observations* — never the raw
 * message text (invariant I4). Raw text only ever leaves the phone through the
 * separate, per-message consent flow for template synthesis.
 *
 * Everything here is treated as hostile input. In particular the payload carries no
 * user id: identity comes from the authenticated device principal, because a
 * body-supplied user id would make this endpoint a way to write into any account.
 */

/**
 * One page of a sync. A device syncing a fresh inbox may hold months of alerts, so
 * clients page rather than posting everything; an unbounded batch is a memory and
 * transaction-duration risk on both ends.
 */
export const MAX_OBSERVATIONS_PER_BATCH = 500;

const ulid = z.string().refine(isUlid, { message: 'must be a ULID' });

/** Unsigned magnitude in minor units. Direction carries the sign, never the amount. */
const minorUnits = z
  .string()
  .regex(/^\d{1,19}$/, { message: 'must be a non-negative integer in minor units' });

export const observationInputSchema = z.object({
  /** Client-generated, so a retry is idempotent even before the server has replied. */
  id: ulid,
  source: z.enum(['SMS', 'EMAIL', 'STATEMENT', 'USER_STATED']),
  /** SHA-256 hex, computed on-device. Enforces per-source idempotency server-side. */
  dedupeKey: z.string().regex(/^[0-9a-f]{64}$/, { message: 'must be a SHA-256 hex digest' }),
  amountMinor: minorUnits,
  currency: z.enum(['NGN', 'USD']),
  direction: z.enum(['DEBIT', 'CREDIT']),
  occurredAt: z.string().datetime({ offset: true }),
  observedAt: z.string().datetime({ offset: true }),
  balanceAfterMinor: minorUnits.nullish(),
  description: z.string().max(500).nullish(),
  /**
   * The bank's own reference for this entry, when the source states one.
   *
   * Reconciliation's strongest signal by a wide margin: two entries the bank labelled
   * identically are the same entry, which is the only evidence that earns an automatic
   * merge without corroboration from the reported balance (ADR-008 §4). Optional because
   * most SMS alerts omit it and no parse template extracts it yet — the field exists so
   * that matching is not silently unreachable once they do.
   */
  rawReference: z.string().max(128).nullish(),
  accountLast4: z
    .string()
    .regex(/^\d{4}$/, { message: 'must be exactly four digits' })
    .nullish(),
  institutionId: ulid.nullish(),
  /** Which published template produced this reading, for parse-quality telemetry. */
  templateId: ulid.nullish(),
});

export const syncObservationsSchema = z.object({
  observations: z.array(observationInputSchema).min(1).max(MAX_OBSERVATIONS_PER_BATCH),
});

export type ObservationInput = z.infer<typeof observationInputSchema>;
export type SyncObservationsRequest = z.infer<typeof syncObservationsSchema>;

export type IntakeStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

export interface IntakeResult {
  readonly id: string;
  readonly status: IntakeStatus;
  readonly reason?: string;
}

export interface SyncObservationsResponse {
  readonly results: readonly IntakeResult[];
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
}
