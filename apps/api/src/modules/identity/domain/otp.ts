import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * One-time codes for phone sign-in.
 *
 * This is the most attacked surface in the product: it mints credentials, and the secret is
 * six digits. The security does **not** come from the code's entropy — a million
 * possibilities is nothing — it comes from three limits enforced together:
 *
 *   1. **Single use.** A consumed challenge is dead, so a correct guess is worth one attempt.
 *   2. **Attempt cap.** Five wrong guesses kill the challenge, making the expected cost of
 *      guessing ~200,000 challenges rather than ~500,000 guesses.
 *   3. **Short expiry.** A challenge is worthless after ten minutes.
 *
 * Remove any one of those and six digits becomes trivially brute-forceable. They are
 * enforced in `PhoneAuthService` against the database rather than in memory, so they hold
 * across instances and restarts.
 *
 * ## On hashing the code
 *
 * The code is hashed at rest, but this is defence in depth and nothing more: a six-digit
 * SHA-256 is reversible by brute force in milliseconds. It protects against casual
 * disclosure — a log line, a screenshot of a query result, a backup someone opens — not
 * against an attacker with the table. The real protection is the three limits above, and it
 * would be dishonest to describe the hash as doing more than it does.
 */

/** Six digits: what a person can read from an SMS and type without error. */
const CODE_DIGITS = 6;

export const OTP_TTL_MS = 10 * 60 * 1_000;

/** Wrong guesses before a challenge is dead. */
export const MAX_OTP_ATTEMPTS = 5;

/** Challenges one phone number may start within the window below. */
export const MAX_CHALLENGES_PER_PHONE = 5;
export const CHALLENGE_RATE_WINDOW_MS = 15 * 60 * 1_000;

/**
 * Generates a code using `randomInt`, which is a CSPRNG.
 *
 * `Math.random()` would be predictable enough to defeat the attempt cap entirely: an
 * attacker who can observe a few codes can predict the next. Padded rather than
 * range-shifted so every code is the same length and `000123` is reachable.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * A code hash that no six-digit submission can ever match.
 *
 * Used for a throttled challenge, which must look ordinary from outside but be impossible to
 * complete. The obvious implementation — store the hash of a *different* six-digit code — is
 * **broken**, and subtly: six digits is a small enough space that anyone who can read the
 * table can recover that code by brute force in milliseconds and then use it. The decoy would
 * be a working credential.
 *
 * Hashing 256 bits instead keeps the row indistinguishable while putting the preimage outside
 * the space `verifyOtp` can ever submit, since it only ever hashes six digits.
 */
export function unmatchableCodeHash(): string {
  return hashOtpCode(randomBytes(32).toString('hex'));
}

export function otpExpiresAt(now: Date): Date {
  return new Date(now.getTime() + OTP_TTL_MS);
}

export interface ChallengeState {
  readonly codeHash: string;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
}

export type VerificationResult =
  'ok' | 'wrong-code' | 'expired' | 'already-used' | 'too-many-attempts';

/**
 * Decides whether a submitted code is acceptable. Pure, so every branch is testable
 * without a database — which matters more here than anywhere else in the codebase.
 *
 * Order is deliberate: state failures are checked before the code is compared, so a dead
 * challenge cannot be used as an oracle to test guesses for free.
 */
export function verifyOtp(
  challenge: ChallengeState,
  submittedCode: string,
  now: Date,
): VerificationResult {
  if (challenge.consumedAt !== null) return 'already-used';
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) return 'too-many-attempts';
  if (now.getTime() >= challenge.expiresAt.getTime()) return 'expired';

  return challenge.codeHash === hashOtpCode(submittedCode) ? 'ok' : 'wrong-code';
}

/**
 * Nigerian mobile numbers in E.164.
 *
 * Deliberately narrow: this is the identifier a user is known by, so accepting a shape the
 * SMS provider cannot deliver to would create an account nobody can ever sign into again.
 * `+234` followed by a leading digit of 7, 8 or 9 and nine more — the current NCC mobile
 * ranges.
 */
const NIGERIAN_MOBILE = /^\+234[789]\d{9}$/;

export function isSupportedPhone(value: string): boolean {
  return NIGERIAN_MOBILE.test(value);
}

/**
 * Normalises the ways a Nigerian number gets typed into the one stored form.
 *
 * `08012345678`, `2348012345678` and `+234 801 234 5678` are the same person, and storing
 * them as three identities would silently split one user's ledger across three accounts.
 * Returns null when the input is not a recognisable Nigerian mobile number rather than
 * guessing.
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '');

  const candidate = digits.startsWith('+')
    ? digits
    : digits.startsWith('234')
      ? `+${digits}`
      : digits.startsWith('0')
        ? `+234${digits.slice(1)}`
        : `+234${digits}`;

  return isSupportedPhone(candidate) ? candidate : null;
}
