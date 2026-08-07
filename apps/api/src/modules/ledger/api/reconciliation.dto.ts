import { z } from 'zod';

/**
 * Request shapes for the reconciliation surface.
 *
 * No request carries a user id, ever. Identity comes from the authenticated principal;
 * accepting one in a body would let any device reshape any other user's ledger, and these
 * endpoints change what money exists.
 */

const ulid = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { message: 'must be a ULID' });

export const resolveDuplicateSchema = z.object({
  /**
   * `MERGED` collapses the pair into one transaction; `KEPT_SEPARATE` records that they are
   * genuinely different money, which stops the pair being queued again.
   */
  resolution: z.enum(['MERGED', 'KEPT_SEPARATE']),
});

export type ResolveDuplicateRequest = z.infer<typeof resolveDuplicateSchema>;

export const splitObservationSchema = z.object({
  /** The observation to move onto a transaction of its own. */
  observationId: ulid,
});

export type SplitObservationRequest = z.infer<typeof splitObservationSchema>;

export const listGapsSchema = z.object({
  accountId: ulid,
  currency: z.enum(['NGN', 'USD']),
});

export type ListGapsRequest = z.infer<typeof listGapsSchema>;

export const resolveGapSchema = z.object({
  accountId: ulid,
  currency: z.enum(['NGN', 'USD']),
  afterTransactionId: ulid,
  beforeTransactionId: ulid,
  /**
   * `EXPLAINED` means the user accounted for the missing money; `DISMISSED` means they do
   * not want to be asked. Either way no transaction is created — the gap yields an amount
   * and a time range and nothing else, so inventing one would be a figure no source
   * reported.
   */
  resolution: z.enum(['EXPLAINED', 'DISMISSED']),
});

export type ResolveGapRequest = z.infer<typeof resolveGapSchema>;
