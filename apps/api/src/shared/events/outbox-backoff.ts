/**
 * Retry schedule for undelivered outbox events.
 *
 * Pure and deterministic so it can be tested directly, and so two relay instances compute
 * the same schedule for the same row.
 *
 * ## No jitter, deliberately
 *
 * Jitter exists to stop many clients retrying in lockstep after a shared failure. That
 * cannot happen here: a row is claimed by exactly one relay via `FOR UPDATE SKIP LOCKED`,
 * the batch size caps how many are in flight, and rows that failed together still carry
 * different attempt counts once they diverge. Adding randomness would buy nothing and cost
 * the property that a row's next attempt time is predictable from its state — which is
 * what makes a stuck backlog diagnosable.
 */

/** First retry delay. Short, because the common failure is a transient blip. */
export const BASE_RETRY_DELAY_MS = 2_000;

/**
 * Ceiling on the delay. Ten minutes rather than hours: an event that stops being delivered
 * is a user's transaction not appearing, so the backlog must keep trying at a rate someone
 * would notice being wrong.
 */
export const MAX_RETRY_DELAY_MS = 10 * 60 * 1_000;

/**
 * Delay before the next attempt, given how many have already happened.
 *
 * `attempts` is the count *including* the one that just failed, so the first failure
 * (attempts = 1) waits the base delay rather than nothing.
 */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 1) return BASE_RETRY_DELAY_MS;

  // Doubling in the exponent space rather than looping, and clamped before it can
  // overflow into Infinity for an absurd attempt count.
  const exponent = Math.min(attempts - 1, 32);
  const delay = BASE_RETRY_DELAY_MS * 2 ** exponent;

  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/** When a row that has just failed becomes eligible again. */
export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + retryDelayMs(attempts));
}
