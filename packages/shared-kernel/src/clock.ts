/**
 * Clock — time as an injected dependency.
 *
 * Reconciliation matches observations inside time windows (ARCHITECTURE §5.1) and
 * proactivity fires on schedules, so time-dependent logic is everywhere. Injecting
 * the clock is what makes that logic testable without sleeping.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** Test double: time stands still until you move it. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current.getTime();
  }

  set(instant: Date): void {
    this.current = instant;
  }

  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export const CLOCK = Symbol.for('atlas.Clock');
