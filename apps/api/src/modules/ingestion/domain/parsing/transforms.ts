import {
  type CurrencyCode,
  err,
  isCurrencyCode,
  Money,
  ok,
  type Result,
} from '@atlas/shared-kernel';

/**
 * Field transforms for the SMS/email template DSL (ADR-004).
 *
 * These run on **both** the server (TypeScript) and the device (Dart), against the
 * same template definitions. That constraint is why the date parser is written by
 * hand rather than delegated to date-fns: a format token must mean exactly the same
 * thing in both runtimes, and two libraries with subtly different `MMM` handling
 * would produce two different ledgers from the same message.
 *
 * Every transform is total and deterministic — it returns a Result rather than
 * throwing, because a parse failure is an expected outcome that feeds the template
 * flywheel, not an exceptional one.
 */

export type TransactionDirection = 'DEBIT' | 'CREDIT';

export interface ParseContext {
  /**
   * Minutes east of UTC for the institution's local time.
   *
   * Bank alerts state local wall-clock time with no offset. Africa/Lagos is UTC+1
   * year-round with no DST, so a fixed offset is exact for v0.1. Expanding to a
   * zone that observes DST requires a real IANA database — do not simply widen
   * this number.
   */
  readonly utcOffsetMinutes: number;
  readonly defaultCurrency: CurrencyCode;
}

export const LAGOS_UTC_OFFSET_MINUTES = 60;

/** Longest SMS we will attempt to parse — a concatenated message tops out here. */
export const MAX_MESSAGE_LENGTH = 1600;

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

/**
 * Parses a monetary amount into exact minor units.
 *
 * Strips currency prefixes banks put inline ("NGN5,000.00", "₦5,000.00") and
 * delegates to Money, which rejects unexpected precision rather than rounding.
 * That rejection matters: three decimal places usually means the pattern matched
 * something that is not an amount, and guessing would corrupt the ledger.
 */
export function parseAmount(raw: string, currency: CurrencyCode): Result<Money, string> {
  const stripped = raw
    .trim()
    .replace(/^(NGN|USD|N|₦|\$)\s*/i, '')
    .replace(/\s*(NGN|USD)$/i, '')
    .trim();

  if (stripped === '') return err(`empty amount in '${raw}'`);

  try {
    return ok(Money.fromDecimalString(stripped, currency));
  } catch (error) {
    return err(error instanceof Error ? error.message : `invalid amount '${raw}'`);
  }
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Readonly<Record<string, CurrencyCode>> = {
  '₦': 'NGN',
  N: 'NGN',
  $: 'USD',
};

export function parseCurrency(raw: string): Result<CurrencyCode, string> {
  const token = raw.trim().toUpperCase();

  if (isCurrencyCode(token)) return ok(token);

  const symbol = CURRENCY_SYMBOLS[token];
  if (symbol) return ok(symbol);

  return err(`unsupported currency '${raw}'`);
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

const DEBIT_TOKENS = new Set(['DR', 'DEBIT', 'DEBITED', 'WITHDRAWAL', 'PAYMENT', 'OUT']);
const CREDIT_TOKENS = new Set(['CR', 'CREDIT', 'CREDITED', 'DEPOSIT', 'RECEIVED', 'IN']);

export function parseDirection(raw: string): Result<TransactionDirection, string> {
  const token = raw.trim().toUpperCase().replace(/[.:]/g, '');

  if (DEBIT_TOKENS.has(token)) return ok('DEBIT');
  if (CREDIT_TOKENS.has(token)) return ok('CREDIT');

  return err(`cannot determine direction from '${raw}'`);
}

// ---------------------------------------------------------------------------
// Date / time
// ---------------------------------------------------------------------------

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * Supported format tokens. Deliberately small — every token here must be
 * implementable identically in Dart.
 *
 *   YYYY  4-digit year        YY  2-digit year (assumed 2000s)
 *   MMM   3-letter month      MM  2-digit month
 *   DD    2-digit day         HH  2-digit hour (24h)
 *   mm    2-digit minute      ss  2-digit second
 *
 * Anything else in the format string matches itself literally. There is no
 * 12-hour or locale-dependent token, because ambiguity in a date is indistinguishable
 * from a wrong date once it is in the ledger.
 */
const TOKEN_PATTERNS: readonly (readonly [string, string])[] = [
  ['YYYY', '(?<YYYY>\\d{4})'],
  ['MMM', '(?<MMM>[A-Za-z]{3})'],
  ['YY', '(?<YY>\\d{2})'],
  ['MM', '(?<MM>\\d{2})'],
  ['DD', '(?<DD>\\d{2})'],
  ['HH', '(?<HH>\\d{2})'],
  ['mm', '(?<mm>\\d{2})'],
  ['ss', '(?<ss>\\d{2})'],
];

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a format string such as `DD-MMM-YYYY HH:mm:ss` into an anchored regex. */
export function compileDateFormat(format: string): Result<RegExp, string> {
  let pattern = '';
  let index = 0;
  const seen = new Set<string>();

  outer: while (index < format.length) {
    for (const [token, pieces] of TOKEN_PATTERNS) {
      if (!format.startsWith(token, index)) continue;
      if (seen.has(token)) return err(`duplicate token '${token}' in format '${format}'`);

      seen.add(token);
      pattern += pieces;
      index += token.length;
      continue outer;
    }

    pattern += escapeLiteral(format[index] as string);
    index += 1;
  }

  if (!seen.has('YYYY') && !seen.has('YY')) return err(`format '${format}' has no year`);
  if (!seen.has('MM') && !seen.has('MMM')) return err(`format '${format}' has no month`);
  if (!seen.has('DD')) return err(`format '${format}' has no day`);

  return ok(new RegExp(`^${pattern}$`));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses a local wall-clock timestamp into a UTC instant.
 *
 * Bank alerts carry no offset, so the institution's offset is applied here. Getting
 * this wrong shifts every transaction by an hour and quietly breaks "what did I
 * spend today" at both ends of the day.
 */
export function parseDateTime(
  raw: string,
  format: string,
  context: ParseContext,
): Result<Date, string> {
  const compiled = compileDateFormat(format);
  if (!compiled.ok) return compiled;

  const match = compiled.value.exec(raw.trim());
  if (!match?.groups) return err(`'${raw}' does not match format '${format}'`);

  const groups = match.groups;

  const year = groups['YYYY'] ? Number(groups['YYYY']) : 2000 + Number(groups['YY'] as string);

  let month: number;
  if (groups['MMM']) {
    const named = MONTH_NAMES[groups['MMM'].toUpperCase()];
    if (!named) return err(`unknown month name '${groups['MMM']}'`);
    month = named;
  } else {
    month = Number(groups['MM'] as string);
  }

  const day = Number(groups['DD'] as string);
  const hour = groups['HH'] ? Number(groups['HH']) : 0;
  const minute = groups['mm'] ? Number(groups['mm']) : 0;
  const second = groups['ss'] ? Number(groups['ss']) : 0;

  // Reject impossible dates rather than letting Date silently roll them over:
  // "31/02/2026" becoming 3 March is a wrong transaction date, not a parse.
  if (month < 1 || month > 12) return err(`month ${month} out of range in '${raw}'`);
  if (day < 1 || day > daysInMonth(year, month)) return err(`day ${day} out of range in '${raw}'`);
  if (hour > 23) return err(`hour ${hour} out of range in '${raw}'`);
  if (minute > 59) return err(`minute ${minute} out of range in '${raw}'`);
  if (second > 59) return err(`second ${second} out of range in '${raw}'`);

  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second) - context.utcOffsetMinutes * 60 * 1000;

  return ok(new Date(utcMillis));
}

// ---------------------------------------------------------------------------
// Account identifier
// ---------------------------------------------------------------------------

/**
 * Extracts the trailing four digits banks use to identify an account
 * ("Acct: **1234", "XXXXXX1234"). Only the last four are ever retained — the full
 * number is sensitive and the device has no reason to keep it.
 */
export function parseAccountLast4(raw: string): Result<string, string> {
  const digits = raw.replace(/\D/g, '');

  if (digits.length < 4) return err(`'${raw}' contains fewer than four digits`);

  return ok(digits.slice(-4));
}
