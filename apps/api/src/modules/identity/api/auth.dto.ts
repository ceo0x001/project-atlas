import { z } from 'zod';
import { normalisePhone } from '../domain/otp';

/**
 * Sign-in request shapes.
 *
 * Normalisation happens here, at the edge, so that everything behind it works with one
 * canonical phone format. `08012345678`, `2348012345678` and `+234 801 234 5678` are the
 * same person, and letting three spellings through would split one user's ledger across
 * three accounts — a data-integrity failure that is very hard to unpick afterwards.
 */

export const startSignInSchema = z.object({
  /**
   * Accepted in any common Nigerian spelling and transformed to E.164. A number that is not
   * a recognisable Nigerian mobile is refused rather than guessed at: creating an account on
   * an undeliverable number locks that person out permanently, because the only way back in
   * is a code sent to it.
   */
  phone: z
    .string()
    .min(7)
    .max(20)
    .transform((value, ctx) => {
      const normalised = normalisePhone(value);

      if (normalised === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be a Nigerian mobile number',
        });

        return z.NEVER;
      }

      return normalised;
    }),
});

export type StartSignInRequest = z.infer<typeof startSignInSchema>;

const INGESTION_ROLES = ['INGESTION_NODE', 'CLIENT_AND_INGESTION_NODE'] as const;

export const verifySignInSchema = z
  .object({
    challengeId: z.string().length(26),
    /** Exactly six digits. A wrong shape is refused without spending an attempt. */
    code: z.string().regex(/^\d{6}$/, { message: 'must be six digits' }),
    platform: z.enum(['ANDROID', 'IOS']),
    role: z.enum(['CLIENT', 'INGESTION_NODE', 'CLIENT_AND_INGESTION_NODE']),
    model: z.string().max(100).optional(),
    osVersion: z.string().max(50).optional(),
    appVersion: z.string().max(50).optional(),
  })
  .superRefine((body, ctx) => {
    // An iOS device cannot read SMS (ADR-006), so it must not be enrolled as one that can.
    // Refused rather than silently downgraded: a client that believes it is an ingestion
    // node would wait forever for alerts it can never observe, and the user would conclude
    // the product does not work.
    if (body.platform === 'IOS' && (INGESTION_ROLES as readonly string[]).includes(body.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'an iOS device cannot be an ingestion node: iOS does not permit SMS access',
      });
    }
  });

export type VerifySignInRequest = z.infer<typeof verifySignInSchema>;
