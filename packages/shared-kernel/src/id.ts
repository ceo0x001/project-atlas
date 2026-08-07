import { factory, monotonicFactory } from 'ulid';

/**
 * Identifiers are ULIDs: lexicographically sortable by creation time, URL-safe, and
 * generatable on the client. That last property matters — the mobile app creates
 * transaction observations offline (ARCHITECTURE §9) and needs a stable id before
 * it has ever spoken to the server, which makes sync idempotent by construction.
 *
 * Ids are branded per entity so a TransactionId can never be passed where an
 * AccountId is expected.
 */

declare const brand: unique symbol;

type Branded<T extends string> = string & { readonly [brand]: T };

export type UserId = Branded<'UserId'>;
export type DeviceId = Branded<'DeviceId'>;
export type AccountId = Branded<'AccountId'>;
export type TransactionId = Branded<'TransactionId'>;
export type ObservationId = Branded<'ObservationId'>;
export type CategoryId = Branded<'CategoryId'>;
export type MerchantId = Branded<'MerchantId'>;
export type InstitutionId = Branded<'InstitutionId'>;
export type InsightId = Branded<'InsightId'>;
export type FactId = Branded<'FactId'>;
export type EpisodeId = Branded<'EpisodeId'>;
export type SessionId = Branded<'SessionId'>;
export type TurnId = Branded<'TurnId'>;
export type TemplateId = Branded<'TemplateId'>;
export type EventId = Branded<'EventId'>;

/**
 * Monotonic within a process, so ids minted in the same millisecond still sort in
 * creation order — important for turn ordering and event replay.
 */
const nextUlid = monotonicFactory();

export function newId<T extends string>(): Branded<T> {
  return nextUlid() as Branded<T>;
}

/** Parse an untrusted string into a branded id, validating ULID shape. */
export function toId<T extends string>(value: string): Branded<T> {
  if (!isUlid(value)) {
    throw new Error(`'${value}' is not a valid ULID`);
  }
  return value as Branded<T>;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Fully deterministic id generation, for tests and fixtures.
 *
 * The same seed always yields the same ULID. A previous version seeded only the
 * timestamp half and left the random half random, so two calls with one seed
 * produced *different* ids — which silently broke any test that generated an id
 * during setup and regenerated it during assertion.
 *
 * Seeds both halves: the timestamp from the seed, and the random component from a
 * small xorshift PRNG driven by the same seed.
 */
export function idFromSeed<T extends string>(seed: number): Branded<T> {
  // Zero is a fixed point for xorshift, so fall back to the golden-ratio constant.
  let state = seed >>> 0 || 0x9e37_79b9;

  const prng = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };

  return factory(prng)(seed) as Branded<T>;
}
