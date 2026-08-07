import { type CurrencyCode, Money } from '@atlas/shared-kernel';
import type { StatementRow } from './statement-row';

/**
 * The hard validation gate on statement imports (ARCHITECTURE §6.3).
 *
 * A statement is trustworthy as a **whole document or not at all.** Every parse of every
 * layout is a guess about somebody else's file format, and the failure mode that matters is
 * not a parse that breaks loudly — it is one that reads nine rows out of ten and imports them
 * silently. The user then sees a total that is wrong by exactly the row nobody noticed, and
 * has no way to tell.
 *
 * So the rule is absolute: **either the arithmetic closes and the whole statement is
 * imported, or none of it is.** There is no partial import, and there is deliberately no
 * option to force one.
 *
 * ## What is checked, strongest first
 *
 * 1. **The running-balance chain.** When rows carry balances, each row's balance must equal
 *    the previous one plus that row's signed amount. This catches a missed row, a duplicated
 *    row, a misread amount, and a wrong direction — the entire class of parse defects — at
 *    the exact line where it happened.
 * 2. **Endpoints only.** When rows carry no balances but the caller supplies the statement's
 *    stated opening and closing figures, the sum of the rows must bridge them. Weaker: two
 *    errors that cancel out would pass, though that is far less likely than one error.
 * 3. **Nothing available.** Rejected. An import that cannot be checked is not a safer
 *    version of an import that fails a check — it is the same risk with the warning removed.
 */

export type GateRejection =
  | { readonly kind: 'no-rows' }
  | { readonly kind: 'mixed-currency'; readonly found: readonly string[] }
  | {
      readonly kind: 'balance-chain-broken';
      readonly lineNumber: number;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'endpoints-do-not-bridge';
      readonly expectedClosing: string;
      readonly statedClosing: string;
    }
  | { readonly kind: 'unverifiable' }
  | { readonly kind: 'rows-out-of-order'; readonly lineNumber: number }
  | {
      /**
       * The opening balance implied by the rows disagrees with the one the statement states.
       * Usually means the first row's direction was read backwards — the one parse error the
       * balance chain alone cannot see.
       */
      readonly kind: 'opening-balance-mismatch';
      readonly derived: string;
      readonly stated: string;
    };

export interface GateAcceptance {
  readonly openingBalance: Money | null;
  readonly closingBalance: Money | null;
  /** How the statement was verified, recorded so a reviewer knows how strong the check was. */
  readonly method: 'balance-chain' | 'endpoints';
  readonly netMovement: Money;
}

export type GateResult =
  | { readonly ok: true; readonly value: GateAcceptance }
  | { readonly ok: false; readonly rejection: GateRejection };

export interface StatedBalances {
  readonly opening: Money | null;
  readonly closing: Money | null;
}

/**
 * @param rows In the order the statement printed them. Order matters: a running balance is
 *   only meaningful in sequence, and a statement that is not chronological cannot be checked
 *   this way at all.
 */
export function applyReconciliationGate(
  rows: readonly StatementRow[],
  currency: CurrencyCode,
  stated: StatedBalances = { opening: null, closing: null },
): GateResult {
  if (rows.length === 0) return reject({ kind: 'no-rows' });

  const currencies = [...new Set(rows.map((row) => row.amount.currency))];
  if (currencies.length > 1 || currencies[0] !== currency) {
    return reject({ kind: 'mixed-currency', found: [...currencies, currency].sort() });
  }

  const ordering = checkChronological(rows);
  if (ordering !== null) return reject(ordering);

  const netMovement = Money.sum(
    rows.map((row) => signedAmount(row)),
    currency,
  );

  const withBalances = rows.filter((row) => row.balanceAfter !== null);

  // Every row or none. A statement where only some lines carry a balance is a parse that
  // found the column intermittently, which is itself evidence the mapping is wrong.
  if (withBalances.length === rows.length) {
    return checkBalanceChain(rows, netMovement, stated.opening);
  }

  if (stated.opening !== null && stated.closing !== null) {
    return checkEndpoints(stated.opening, stated.closing, netMovement);
  }

  return reject({ kind: 'unverifiable' });
}

/**
 * The strong check: the bank's own running balance must agree with the bank's own amounts, at
 * every single line.
 */
function checkBalanceChain(
  rows: readonly StatementRow[],
  netMovement: Money,
  statedOpening: Money | null,
): GateResult {
  const first = rows[0];
  if (first?.balanceAfter == null) return reject({ kind: 'unverifiable' });

  // The opening figure is implied rather than printed: the balance after the first line, less
  // what that line did.
  const opening = first.balanceAfter.minus(signedAmount(first));

  // Deriving the opening from the first row leaves one blind spot: if that row's *direction*
  // were read backwards, the derived opening absorbs the error and the chain still closes.
  // Every later row is protected, because its predecessor's balance is already pinned. When
  // the statement's own opening figure is available, comparing it here closes the gap
  // entirely — which is the reason to supply it even for a statement that has balances.
  if (statedOpening !== null && !statedOpening.equals(opening)) {
    return reject({
      kind: 'opening-balance-mismatch',
      derived: opening.toDecimalString(),
      stated: statedOpening.toDecimalString(),
    });
  }

  let running = opening;

  for (const row of rows) {
    running = running.plus(signedAmount(row));

    // Non-null by the caller's filter, but re-checked rather than asserted: a `!` here would
    // be a claim about a different function's behaviour.
    const printed = row.balanceAfter;
    if (printed === null) return reject({ kind: 'unverifiable' });

    if (!printed.equals(running)) {
      return reject({
        kind: 'balance-chain-broken',
        lineNumber: row.lineNumber,
        expected: running.toDecimalString(),
        actual: printed.toDecimalString(),
      });
    }
  }

  return {
    ok: true,
    value: {
      openingBalance: opening,
      closingBalance: running,
      method: 'balance-chain',
      netMovement,
    },
  };
}

/**
 * The weaker check, used when the layout prints no running balance.
 *
 * Two compensating errors would slip through. That is accepted as the price of importing a
 * statement that genuinely lacks the column, and the accepted result records which method was
 * used so the difference is never invisible.
 */
function checkEndpoints(opening: Money, closing: Money, netMovement: Money): GateResult {
  const expected = opening.plus(netMovement);

  if (!expected.equals(closing)) {
    return reject({
      kind: 'endpoints-do-not-bridge',
      expectedClosing: expected.toDecimalString(),
      statedClosing: closing.toDecimalString(),
    });
  }

  return {
    ok: true,
    value: { openingBalance: opening, closingBalance: closing, method: 'endpoints', netMovement },
  };
}

/**
 * Statements are printed in order, and the balance chain is meaningless otherwise.
 *
 * Rejected rather than sorted. Sorting would paper over the far likelier explanation — that
 * the date column was mis-detected, or dates were parsed with the wrong day/month order — and
 * silently produce a plausible, wrong statement.
 */
function checkChronological(rows: readonly StatementRow[]): GateRejection | null {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous === undefined || current === undefined) continue;

    if (current.occurredAt.getTime() < previous.occurredAt.getTime()) {
      return { kind: 'rows-out-of-order', lineNumber: current.lineNumber };
    }
  }

  return null;
}

/** A credit raises the balance, a debit lowers it. Through Money, so currency mixing throws. */
function signedAmount(row: StatementRow): Money {
  return row.direction === 'CREDIT' ? row.amount : row.amount.negate();
}

function reject(rejection: GateRejection): GateResult {
  return { ok: false, rejection };
}

/** A message a person can act on: which line, and what the numbers were. */
export function describeRejection(rejection: GateRejection): string {
  switch (rejection.kind) {
    case 'no-rows':
      return 'No transaction rows were found in the file';
    case 'mixed-currency':
      return `Rows span more than one currency (${rejection.found.join(', ')})`;
    case 'balance-chain-broken':
      return (
        `The running balance does not add up at line ${rejection.lineNumber}: ` +
        `the rows imply ${rejection.expected} but the statement prints ${rejection.actual}. ` +
        'A row is probably missing or misread, so nothing has been imported.'
      );
    case 'endpoints-do-not-bridge':
      return (
        `The rows do not bridge the stated balances: they imply a closing balance of ` +
        `${rejection.expectedClosing} but the statement states ${rejection.statedClosing}. ` +
        'Nothing has been imported.'
      );
    case 'unverifiable':
      return (
        'This statement carries no running balance and no stated opening and closing ' +
        'balances, so its totals cannot be checked. Nothing has been imported.'
      );
    case 'rows-out-of-order':
      return (
        `Line ${rejection.lineNumber} is dated before the line above it. The date column may ` +
        'have been read incorrectly, so nothing has been imported.'
      );
    case 'opening-balance-mismatch':
      return (
        `The rows imply an opening balance of ${rejection.derived} but the statement states ` +
        `${rejection.stated}. The first row was probably read as the wrong direction, so ` +
        'nothing has been imported.'
      );
  }
}
