/**
 * Result — explicit success/failure for *expected* domain outcomes.
 *
 * Use Result when failure is a normal branch the caller must handle (a parse that
 * did not match, a transaction that failed reconciliation). Keep throwing for
 * programmer errors and genuinely exceptional conditions (currency mismatch, a
 * violated invariant) — those should crash loudly in development.
 */

export type Result<T, E = Error> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transform the success value, leaving failures untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Extract the value or fall back. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Extract the value or throw — only at boundaries where failure is unrecoverable. */
export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}
