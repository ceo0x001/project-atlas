import { createHash } from 'node:crypto';
import type { ObservationId } from '@atlas/shared-kernel';
import type { TransactionDirection } from './transforms';

/**
 * Deterministic deduplication keys for observations.
 *
 * ## What this is, and what it is not
 *
 * A dedupe key provides **per-source idempotency**: replaying the same SMS from the
 * same device, or re-importing the same statement, must never create a second
 * observation. The device generates these offline and the server enforces
 * uniqueness on `(userId, dedupeKey)`, which makes sync safely retryable.
 *
 * It is emphatically **not** cross-source matching. The same real transaction seen
 * as an SMS alert and again as a statement row will produce two different keys, and
 * that is correct — both are genuine, independent observations. Collapsing them
 * into one canonical transaction is reconciliation's job (ARCHITECTURE §5.1), where
 * the reported balance can be used as an anchor. Conflating the two concerns here
 * would throw away the corroborating evidence that makes gap detection possible.
 *
 * ## Cross-platform contract
 *
 * The device computes these in Dart and the server verifies in TypeScript, so the
 * canonical string below is a wire format. Any change to it is a breaking change
 * that orphans every previously synced observation — version the prefix instead.
 */

/** Bump only alongside a migration that recomputes existing keys. */
const KEY_VERSION = 'v1';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Collapses insignificant whitespace so that the same message read through two code
 * paths hashes identically. Deliberately does not change case: casing can be
 * meaningful in a narration, and folding it risks merging distinct transactions.
 */
export function normaliseForHash(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export interface SmsDedupeInput {
  readonly senderId: string;
  readonly body: string;
  /** OS-assigned timestamp; stable across re-reads of the inbox. */
  readonly receivedAt: Date;
}

export function smsDedupeKey(input: SmsDedupeInput): string {
  const canonical = [
    KEY_VERSION,
    'sms',
    normaliseForHash(input.senderId),
    String(input.receivedAt.getTime()),
    normaliseForHash(input.body),
  ].join('|');

  return sha256Hex(canonical);
}

export interface StatementRowDedupeInput {
  readonly accountLast4: string | null;
  readonly occurredAt: Date;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly direction: TransactionDirection;
  readonly description: string | null;
  /**
   * The bank's own reference for the row, when the statement provides one. This is
   * what makes the key robust, so prefer it strongly over the ordinal below.
   */
  readonly reference: string | null;
  /**
   * Position among otherwise-identical rows on the same date, used only when no
   * reference exists. Two genuine ₦100 airtime purchases on one day are
   * indistinguishable without it, and silently merging them understates spending.
   */
  readonly occurrenceIndex: number;
}

export function statementRowDedupeKey(input: StatementRowDedupeInput): string {
  const discriminator = input.reference
    ? `ref:${normaliseForHash(input.reference)}`
    : `ord:${input.occurrenceIndex}`;

  const canonical = [
    KEY_VERSION,
    'statement',
    input.accountLast4 ?? '',
    input.occurredAt.toISOString(),
    input.amountMinor.toString(),
    input.currency,
    input.direction,
    normaliseForHash(input.description ?? ''),
    discriminator,
  ].join('|');

  return sha256Hex(canonical);
}

/**
 * A user-stated transaction is unique by construction — the user deliberately
 * created it — so the observation's own id is the stable identity. Hashing content
 * here would merge two genuinely separate "I spent 500 on fuel" entries.
 */
export function userStatedDedupeKey(observationId: ObservationId): string {
  return sha256Hex([KEY_VERSION, 'user', observationId].join('|'));
}
