import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@atlas/shared-kernel';
import { parseCsvStatement, parseMinor, parseStatementDate, splitCsvLine } from './csv-statement';

const NGN = 'NGN' as CurrencyCode;

describe('splitCsvLine', () => {
  it('splits plain cells', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  /** A narration containing a comma is completely ordinary and must not shift the columns. */
  it('keeps a quoted comma inside its cell', () => {
    expect(splitCsvLine('2026-08-01,"POS PURCHASE, SHOPRITE",5000')).toEqual([
      '2026-08-01',
      'POS PURCHASE, SHOPRITE',
      '5000',
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(splitCsvLine('a,"say ""hello""",b')).toEqual(['a', 'say "hello"', 'b']);
  });

  it('preserves empty cells, which is how debit/credit layouts encode direction', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
    expect(splitCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('parseMinor', () => {
  it.each([
    ['5000', 500_000n],
    ['5000.00', 500_000n],
    ['5000.5', 500_050n],
    ['5,000.00', 500_000n],
    ['₦5,000.00', 500_000n],
    ['0.01', 1n],
    ['-250.75', -25_075n],
    ['(250.75)', -25_075n],
  ])('reads %s exactly', (input, expected) => {
    expect(parseMinor(input)).toBe(expected);
  });

  /**
   * Three decimal places is not a rounding problem to solve, it is evidence the column is not
   * money — a rate, or a misaligned cell. Refused rather than truncated.
   */
  it.each([
    ['', null],
    ['abc', null],
    ['1.234', null],
    ['1..2', null],
    ['1e5', null],
  ])('refuses %s rather than coercing it', (input, expected) => {
    expect(parseMinor(input)).toBe(expected);
  });
});

describe('parseStatementDate', () => {
  it('reads ISO dates', () => {
    expect(parseStatementDate('2026-08-07')).toEqual(new Date('2026-08-07T00:00:00.000Z'));
  });

  /**
   * Day-first, because Nigeria writes day-first. Reading 03/04/2026 as 4 March would move a
   * transaction between months while leaving the arithmetic intact — so the reconciliation gate
   * could not catch it. This is the one parse decision the gate cannot protect.
   */
  it('reads an ambiguous slash date day-first', () => {
    expect(parseStatementDate('03/04/2026')).toEqual(new Date('2026-04-03T00:00:00.000Z'));
  });

  it.each([
    ['07/08/2026', '2026-08-07'],
    ['7-8-2026', '2026-08-07'],
    ['07.08.26', '2026-08-07'],
    ['7 Aug 2026', '2026-08-07'],
    ['07-AUG-2026', '2026-08-07'],
    ['7 August 2026', '2026-08-07'],
  ])('reads %s', (input, expected) => {
    expect(parseStatementDate(input)).toEqual(new Date(`${expected}T00:00:00.000Z`));
  });

  /** `Date.UTC(2026, 1, 30)` silently becomes 2 March, which would hide a mis-parse. */
  it.each([['30/02/2026'], ['32/01/2026'], ['01/13/2026'], ['not a date'], ['']])(
    'refuses the impossible date %s',
    (input) => {
      expect(parseStatementDate(input)).toBeNull();
    },
  );
});

describe('parseCsvStatement', () => {
  it('reads a debit/credit layout with a running balance', () => {
    const csv = [
      'Date,Narration,Debit,Credit,Balance',
      '01/08/2026,POS PURCHASE SHOPRITE,2000.00,,8000.00',
      '02/08/2026,SALARY,,500.00,8500.00',
    ].join('\n');

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rows).toHaveLength(2);
    expect(result.value.rows[0]?.direction).toBe('DEBIT');
    expect(result.value.rows[0]?.amount.minor).toBe(200_000n);
    expect(result.value.rows[0]?.description).toBe('POS PURCHASE SHOPRITE');
    expect(result.value.rows[1]?.direction).toBe('CREDIT');
    expect(result.value.rows[1]?.balanceAfter?.minor).toBe(850_000n);
  });

  it('reads a signed single-amount layout', () => {
    const csv = [
      'Transaction Date,Details,Amount,Running Balance',
      '2026-08-01,POS PURCHASE,-2000.00,8000.00',
      '2026-08-02,SALARY,500.00,8500.00',
    ].join('\n');

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rows[0]?.direction).toBe('DEBIT');
    expect(result.value.rows[0]?.amount.minor).toBe(200_000n);
    expect(result.value.rows[1]?.direction).toBe('CREDIT');
  });

  it('matches headers regardless of case, spacing and punctuation', () => {
    const csv = ['VALUE_DATE , PARTICULARS , MONEY OUT , MONEY IN', '2026-08-01,X,100.00,'].join(
      '\n',
    );

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.columnMapping).toMatchObject({ date: 'VALUE_DATE' });
      expect(result.value.rows[0]?.direction).toBe('DEBIT');
    }
  });

  it('strips a byte-order mark so the first header still matches', () => {
    const csv = '﻿Date,Amount\n2026-08-01,-100.00';

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const csv = 'Date,Amount\r\n2026-08-01,-100.00\r\n2026-08-02,50.00\r\n';

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toHaveLength(2);
  });

  it('skips lines with no movement rather than importing zeroes', () => {
    const csv = [
      'Date,Narration,Debit,Credit,Balance',
      '01/08/2026,OPENING BALANCE,,,10000.00',
      '01/08/2026,POS PURCHASE,2000.00,,8000.00',
      ',SUBTOTAL,,,',
    ].join('\n');

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toHaveLength(1);
  });

  it.each([
    ['no date column', 'Narration,Amount\nX,-100.00'],
    ['no amount column', 'Date,Narration\n2026-08-01,X'],
  ])('refuses a file with %s', (_label, csv) => {
    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('missing-column');
  });

  it('refuses an empty file', () => {
    expect(parseCsvStatement('', NGN).ok).toBe(false);
  });

  /**
   * Padding a short row would invent an empty amount, which the gate would then report as an
   * inconsistency at the wrong line — sending someone to look at the wrong place in their file.
   */
  it('refuses a row with fewer columns than the header', () => {
    const csv = ['Date,Narration,Debit,Credit,Balance', '01/08/2026,POS PURCHASE,2000.00'].join(
      '\n',
    );

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'ragged-row', lineNumber: 2 });
  });

  it('reports an unreadable date with its line number', () => {
    const csv = ['Date,Amount', '2026-08-01,-100.00', 'the 3rd of never,-50.00'].join('\n');

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'unparseable-cell', lineNumber: 3 });
  });

  it('captures the bank reference when the layout carries one', () => {
    const csv = ['Date,Narration,Amount,Reference', '2026-08-01,TRANSFER,-100.00,FT21234567'].join(
      '\n',
    );

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows[0]?.reference).toBe('FT21234567');
  });

  it('numbers lines the way a spreadsheet does, so an error points at the right row', () => {
    const csv = ['Date,Amount', '2026-08-01,-100.00', '2026-08-02,-200.00'].join('\n');

    const result = parseCsvStatement(csv, NGN);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows[0]?.lineNumber).toBe(2);
      expect(result.value.rows[1]?.lineNumber).toBe(3);
    }
  });
});
