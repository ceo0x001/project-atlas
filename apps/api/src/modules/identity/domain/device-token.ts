import { createHash, randomBytes } from 'node:crypto';

/**
 * Device bearer tokens.
 *
 * The token is 256 bits from a CSPRNG and is shown exactly once, at enrolment. Only
 * its SHA-256 is stored, so a database dump cannot be replayed as a device.
 *
 * **Why plain SHA-256 and not bcrypt/argon2.** Password hashing is deliberately slow
 * because passwords are low-entropy and guessable. This token is not chosen by a
 * human: 256 random bits are not brute-forceable regardless of hash speed, and a
 * per-request KDF would add latency to every sync for no security gain. The relevant
 * property here is preimage resistance, which SHA-256 has.
 *
 * There is also no secret comparison in application code — the hash is the primary
 * key, so authentication is an index lookup rather than a string compare, which
 * sidesteps timing-attack concerns entirely.
 */

const TOKEN_ENTROPY_BYTES = 32;

export interface IssuedDeviceToken {
  /** Return to the client once. Never persisted, never logged. */
  readonly token: string;
  /** Stored in `device_credentials.tokenHash`. */
  readonly tokenHash: string;
}

export function issueDeviceToken(): IssuedDeviceToken {
  // base64url: safe in an Authorization header with no padding to mishandle.
  const token = randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');

  return { token, tokenHash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerTokenFrom(header: string | undefined): string | null {
  if (!header) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match?.[1] ?? null;
}
