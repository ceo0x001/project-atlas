import { type CurrencyCode, err, Money, ok, type Result } from '@atlas/shared-kernel';
import type { ParsedStatement, StatementRow } from './statement-row';

/**
 * Parses a CSV bank statement.
 *
 * ## Why this is layout-agnostic
 *
 * There is no table of per-bank CSV layouts here, and that is deliberate. I have not seen a
 * real GTBank, Access or Zenith export, and encoding a guess about one would be the same
 * mistake as inventing SMS templates: it would look like support for a bank while quietly
 * producing wrong numbers for it.
 *
 * Instead the parser detects columns from their headers using names that are common across
 * exports, and the reconciliation gate is what makes that safe. A mis-detected column almost
 * always breaks the running-balance arithmetic, so the wrong mapping is caught by the maths
 * rather than trusted. When a real export arrives that this cannot read, the fix is a new
 * header alias — a one-line change with a fixture — not a new parser.
 *
 * ## Two amount shapes
 *
 * Statements express direction in one of two ways, and both are common:
 *
 *   - **Separate debit and credit columns**, one of which is empty per row.
 *   - **One signed amount column**, negative for money out.
 *
 * Both are supported. A file with neither is rejected rather than guessed at.
 */

export type CsvParseFailure =
  | { readonly kind: 'empty-file' }
  | { readonly kind: 'no-header' }
  | { readonly kind: 'missing-column'; readonly field: string; readonly headers: readonly string[] }
  | { readonly kind: 'unparseable-cell'; readonly lineNumber: number; readonly detail: string }
  | { readonly kind: 'ragged-row'; readonly lineNumber: number; readonly detail: string };

/** Header aliases, lower-cased and stripped of punctuation before matching. */
const HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: ['date', 'transactiondate', 'valuedate', 'postingdate', 'trandate', 'effectivedate'],
  description: [
    'description',
    'narration',
    'details',
    'particulars',
    'remarks',
    'transactiondetails',
  ],
  debit: ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'dr', 'debitamount'],
  credit: ['credit', 'deposit', 'deposits', 'moneyin', 'cr', 'creditamount'],
  amount: ['amount', 'transactionamount', 'value'],
  balance: ['balance', 'runningbalance', 'balanceafter', 'closingbalance', 'availablebalance'],
  reference: ['reference', 'ref', 'transactionreference', 'transactionid', 'chequenumber'],
};

function canonicaliseHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function matchField(header: string): string | null {
  const canonical = canonicaliseHeader(header);

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(canonical)) return field;
  }

  return null;
}

export function parseCsvStatement(
  content: string,
  currency: CurrencyCode,
): Result<ParsedStatement, CsvParseFailure> {
  const lines = splitLines(content);
  if (lines.length === 0) return err({ kind: 'empty-file' });

  const [headerLine, ...bodyLines] = lines;
  if (headerLine === undefined) return err({ kind: 'no-header' });

  const headers = splitCsvLine(headerLine);
  const columnMapping: Record<string, string> = {};
  const indexByField = new Map<string, number>();

  headers.forEach((header, index) => {
    const field = matchField(header);
    // First match wins. A later duplicate is ignored rather than silently overriding, because
    // exports sometimes carry both "Value Date" and "Posting Date" and the earlier column is
    // conventionally the one the balance chain follows.
    if (field !== null && !indexByField.has(field)) {
      indexByField.set(field, index);
      columnMapping[field] = header.trim();
    }
  });

  const dateIndex = indexByField.get('date');
  if (dateIndex === undefined) return err({ kind: 'missing-column', field: 'date', headers });

  const hasDebitCredit = indexByField.has('debit') || indexByField.has('credit');
  const hasAmount = indexByField.has('amount');

  if (!hasDebitCredit && !hasAmount) {
    return err({ kind: 'missing-column', field: 'amount or debit/credit', headers });
  }

  const rows: StatementRow[] = [];

  for (const [offset, line] of bodyLines.entries()) {
    // +2: one for the header, one because humans count from one.
    const lineNumber = offset + 2;

    if (line.trim().length === 0) continue;

    const cells = splitCsvLine(line);

    // A row with fewer cells than the header is usually a wrapped narration or a trailing
    // total line. Refused rather than padded: padding invents an empty amount, which the gate
    // would then dutifully find inconsistent at the wrong line.
    if (cells.length < headers.length) {
      return err({
        kind: 'ragged-row',
        lineNumber,
        detail: `expected ${headers.length} columns, found ${cells.length}`,
      });
    }

    const parsed = parseRow(cells, indexByField, lineNumber, currency);
    if (!parsed.ok) return parsed;

    if (parsed.value !== null) rows.push(parsed.value);
  }

  return ok({ rows, currency, columnMapping });
}

function parseRow(
  cells: readonly string[],
  indexByField: ReadonlyMap<string, number>,
  lineNumber: number,
  currency: CurrencyCode,
): Result<StatementRow | null, CsvParseFailure> {
  const cell = (field: string): string => {
    const index = indexByField.get(field);
    return index === undefined ? '' : (cells[index] ?? '').trim();
  };

  const rawDate = cell('date');
  if (rawDate.length === 0) return ok(null); // Blank date: a subtotal or spacer line.

  const occurredAt = parseStatementDate(rawDate);
  if (occurredAt === null) {
    return err({ kind: 'unparseable-cell', lineNumber, detail: `date '${rawDate}'` });
  }

  const debit = parseMinor(cell('debit'));
  const credit = parseMinor(cell('credit'));
  const signed = parseSignedMinor(cell('amount'));

  let amountMinor: bigint;
  let direction: 'DEBIT' | 'CREDIT';

  if (debit !== null && debit !== 0n) {
    amountMinor = debit;
    direction = 'DEBIT';
  } else if (credit !== null && credit !== 0n) {
    amountMinor = credit;
    direction = 'CREDIT';
  } else if (signed !== null && signed !== 0n) {
    amountMinor = signed < 0n ? -signed : signed;
    direction = signed < 0n ? 'DEBIT' : 'CREDIT';
  } else {
    // No movement on this line. Skipped rather than failed: statements carry header repeats,
    // page footers and zero-value markers, and none of them belong in a ledger.
    return ok(null);
  }

  const balanceRaw = cell('balance');
  const balanceMinor = balanceRaw.length === 0 ? null : parseSignedMinor(balanceRaw);

  if (balanceRaw.length > 0 && balanceMinor === null) {
    return err({ kind: 'unparseable-cell', lineNumber, detail: `balance '${balanceRaw}'` });
  }

  const reference = cell('reference');

  return ok({
    lineNumber,
    occurredAt,
    description: cell('description'),
    amount: Money.of(amountMinor, currency),
    direction,
    balanceAfter: balanceMinor === null ? null : Money.of(balanceMinor, currency),
    reference: reference.length === 0 ? null : reference,
  });
}

/**
 * Splits a CSV line, honouring double-quoted fields.
 *
 * Written by hand rather than pulled in as a dependency for the same reason the SMS date
 * parser is: a narration containing a comma is completely ordinary, and getting quoting
 * subtly wrong shifts every subsequent column by one — which produces a plausible statement
 * with the wrong numbers in it.
 */
export function splitCsvLine(line: string): readonly string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (inQuotes) {
      if (character === '"') {
        // A doubled quote inside a quoted field is an escaped literal quote.
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }

  cells.push(current);

  return cells;
}

function splitLines(content: string): readonly string[] {
  return (
    content
      // Excel writes a byte-order mark. Left in place it becomes part of the first header name,
      // so the date column silently fails to match. Escaped rather than written literally: an
      // invisible character in source is a defect waiting to be "tidied away".
      .replace(/^\uFEFF/, '')
      .split(/\r\n|\n|\r/)
      .filter((line, index, all) => line.trim().length > 0 || index < all.length - 1)
  );
}

/**
 * Parses an unsigned money cell into minor units.
 *
 * Thousands separators and a currency symbol are stripped; anything else is a parse failure
 * rather than a coerced zero. `parseFloat` is banned by lint here for good reason — a float
 * cannot represent kobo exactly, and this is the boundary where that would enter the ledger.
 */
export function parseMinor(raw: string): bigint | null {
  const cleaned = raw.replace(/[₦$\s,]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (cleaned.length === 0) return null;

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const kobo = (fraction ?? '').padEnd(2, '0');
  const magnitude = BigInt(`${whole ?? '0'}${kobo}`);

  return sign === '-' ? -magnitude : magnitude;
}

/** As `parseMinor`, but a leading minus or bracketed negative is meaningful. */
export function parseSignedMinor(raw: string): bigint | null {
  return parseMinor(raw);
}

/**
 * Parses a statement date.
 *
 * **Day-first, never month-first.** `03/04/2026` is 3 April in Nigeria and 4 March in the
 * United States, and picking the wrong one silently moves transactions between months — the
 * exact class of error the reconciliation gate exists to catch, but which would pass the gate
 * because the arithmetic is unaffected. So the ambiguity is resolved by locale, not by
 * guessing, and ISO dates are recognised by their unambiguous shape.
 *
 * Midnight UTC is used rather than a Lagos offset: a statement states a date, not a time, and
 * inventing 00:00 West Africa Time would claim precision the document does not have. The
 * projection prefers an alert's real timestamp over this anyway (ADR-008).
 */
export function parseStatementDate(raw: string): Date | null {
  const trimmed = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(trimmed);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dayFirst = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (dayFirst) {
    const year = Number(dayFirst[3]);
    return utcDate(year < 100 ? 2000 + year : year, Number(dayFirst[2]), Number(dayFirst[1]));
  }

  const named = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/.exec(trimmed);
  if (named) {
    const month = MONTHS.indexOf((named[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;

    const year = Number(named[3]);
    return utcDate(year < 100 ? 2000 + year : year, month, Number(named[1]));
  }

  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Rejects impossible dates rather than letting Date roll them over into the next month. */
function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  // `Date.UTC(2026, 1, 30)` silently becomes 2 March. A statement that says 30 February is a
  // mis-parse, and rolling it forward would hide that.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date;
}

export function describeCsvFailure(failure: CsvParseFailure): string {
  switch (failure.kind) {
    case 'empty-file':
      return 'The file is empty';
    case 'no-header':
      return 'The file has no header row';
    case 'missing-column':
      return `Could not find a '${failure.field}' column. Headers found: ${failure.headers.join(', ')}`;
    case 'unparseable-cell':
      return `Could not read ${failure.detail} on line ${failure.lineNumber}`;
    case 'ragged-row':
      return `Line ${failure.lineNumber} does not match the header (${failure.detail})`;
  }
}
