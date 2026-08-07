import { z } from 'zod';

/**
 * Statement upload request.
 *
 * The CSV arrives as a string in the body rather than as multipart form data, because no object
 * store is wired up: the file is parsed and discarded. When object storage lands this becomes an
 * upload URL and a job, and the shape here changes with it.
 */

const ulid = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { message: 'must be a ULID' });

/** Unsigned minor units as a string. Never a number: a kobo total exceeds a safe double. */
const minorUnits = z
  .string()
  .regex(/^-?\d{1,19}$/, { message: 'must be an integer in minor units' });

/** One megabyte of CSV is roughly 10,000 rows — far more than any monthly statement. */
export const MAX_STATEMENT_BYTES = 1_048_576;

export const importStatementSchema = z.object({
  accountId: ulid,
  institutionId: ulid.nullish(),
  filename: z.string().min(1).max(255),
  currency: z.enum(['NGN', 'USD']),
  content: z.string().min(1).max(MAX_STATEMENT_BYTES),
  /**
   * The statement's printed opening and closing balances, if the person uploading can read them
   * off the document. Optional, and worth supplying: they are the only way to catch the first
   * row's direction being reversed, and the only way to verify a layout with no running balance.
   */
  statedOpeningMinor: minorUnits.nullish(),
  statedClosingMinor: minorUnits.nullish(),
});

export type ImportStatementRequest = z.infer<typeof importStatementSchema>;
