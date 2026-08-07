import { describe, expect, it } from 'vitest';
import {
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  nextAttemptAt,
  retryDelayMs,
} from './outbox-backoff';

describe('retryDelayMs', () => {
  it('waits the base delay after the first failure', () => {
    expect(retryDelayMs(1)).toBe(BASE_RETRY_DELAY_MS);
  });

  /** A zero or negative count should never mean "retry instantly, forever". */
  it.each([0, -1])('treats an implausible attempt count of %i as the first', (attempts) => {
    expect(retryDelayMs(attempts)).toBe(BASE_RETRY_DELAY_MS);
  });

  it('doubles with each further attempt', () => {
    expect(retryDelayMs(2)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(retryDelayMs(3)).toBe(BASE_RETRY_DELAY_MS * 4);
    expect(retryDelayMs(4)).toBe(BASE_RETRY_DELAY_MS * 8);
  });

  it('caps the delay so the backlog keeps being retried', () => {
    expect(retryDelayMs(30)).toBe(MAX_RETRY_DELAY_MS);
  });

  /**
   * `2 ** attempts` reaches Infinity long before an attempt count becomes impossible, and
   * `new Date(Infinity)` is an Invalid Date that Postgres rejects — so the exponent is
   * clamped rather than trusted.
   */
  it('stays finite for an absurd attempt count', () => {
    expect(Number.isFinite(retryDelayMs(100_000))).toBe(true);
    expect(retryDelayMs(100_000)).toBe(MAX_RETRY_DELAY_MS);
  });

  it('never returns a delay below the base', () => {
    for (let attempts = 1; attempts <= 40; attempts += 1) {
      expect(retryDelayMs(attempts)).toBeGreaterThanOrEqual(BASE_RETRY_DELAY_MS);
    }
  });

  it('is monotonic up to the cap', () => {
    for (let attempts = 1; attempts <= 40; attempts += 1) {
      expect(retryDelayMs(attempts + 1)).toBeGreaterThanOrEqual(retryDelayMs(attempts));
    }
  });
});

describe('nextAttemptAt', () => {
  it('schedules from the supplied clock, not from the ambient one', () => {
    const now = new Date('2026-08-07T10:00:00.000Z');

    expect(nextAttemptAt(now, 1)).toEqual(new Date('2026-08-07T10:00:02.000Z'));
    expect(nextAttemptAt(now, 3)).toEqual(new Date('2026-08-07T10:00:08.000Z'));
  });

  it('always produces a valid date', () => {
    const now = new Date('2026-08-07T10:00:00.000Z');

    expect(Number.isNaN(nextAttemptAt(now, 100_000).getTime())).toBe(false);
  });
});
