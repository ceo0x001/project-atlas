import type { CurrencyCode, Money } from '@atlas/shared-kernel';
import type { TransactionDirection } from '../parsing/transforms';

/**
 * One line of a bank statement, after parsing and before validation.
 *
 * Deliberately close to what a statement actually prints — a date, a narration, an amount
 * with a direction, and usually a running balance — rather than to what the ledger wants.
 * Translation to observations happens after the rows have been validated as a set, because a
 * statement is only trustworthy as a whole (ARCHITECTURE §6.3).
 */
export interface StatementRow {
  /** 1-based line number in the source file, for error messages a human can act on. */
  readonly lineNumber: number;
  readonly occurredAt: Date;
  readonly description: string;
  readonly amount: Money;
  readonly direction: TransactionDirection;
  /**
   * Running balance the statement printed after this line.
   *
   * Present far more often than not, and when it is present it is the single most valuable
   * field on the row: it lets the whole import be checked against the bank's own arithmetic
   * instead of being trusted.
   */
  readonly balanceAfter: Money | null;
  /** The bank's own reference, when the layout carries one. */
  readonly reference: string | null;
}

export interface ParsedStatement {
  readonly rows: readonly StatementRow[];
  readonly currency: CurrencyCode;
  /** Which header names mapped to which field, so a mis-detection is diagnosable. */
  readonly columnMapping: Readonly<Record<string, string>>;
}
