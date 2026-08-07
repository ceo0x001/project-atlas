import type { FactId, UserId } from '@atlas/shared-kernel';

/**
 * Structured memory (invariant I5, ARCHITECTURE §7.5).
 *
 * Facts are append-only and versioned. A correction never mutates a row: it closes
 * the current version and writes a new one. That is what lets Atlas answer "what
 * did you believe, and when did you start believing it?" — and it means a wrong
 * memory is always recoverable rather than silently overwritten.
 */

export type FactSource = 'USER_STATED' | 'INFERRED' | 'DERIVED';

export interface FactRecord {
  readonly id: FactId;
  readonly userId: UserId;
  /** What the fact is about, e.g. "user", "account:savings", "goal:rent". */
  readonly subject: string;
  /** The relation, e.g. "monthly_salary", "payday_day_of_month", "has_dependents". */
  readonly predicate: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly source: FactSource;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly supersededById: FactId | null;
}

export interface RecallQuery {
  readonly userId: UserId;
  readonly subject?: string;
  readonly predicate?: string;
  /** Semantic query for episodic recall; structured lookup runs first. */
  readonly semantic?: string;
  /** Point-in-time recall. Defaults to now. */
  readonly asOf?: Date;
  readonly limit?: number;
}

export interface MemoryPort {
  remember(fact: Omit<FactRecord, 'id' | 'effectiveTo' | 'supersededById'>): Promise<FactRecord>;

  /** Closes the current version and writes a replacement, preserving history. */
  correct(factId: FactId, value: unknown, source: FactSource): Promise<FactRecord>;

  recall(query: RecallQuery): Promise<readonly FactRecord[]>;
}

export const MEMORY_PORT = Symbol.for('atlas.MemoryPort');
