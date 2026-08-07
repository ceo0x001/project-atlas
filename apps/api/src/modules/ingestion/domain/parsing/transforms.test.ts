import { describe, expect, it } from 'vitest';
import {
  compileDateFormat,
  LAGOS_UTC_OFFSET_MINUTES,
  type ParseContext,
  parseAccountLast4,
  parseAmount,
  parseCurrency,
  parseDateTime,
  parseDirection,
} from './transforms';

const lagos: ParseContext = {
  utcOffsetMinutes: LAGOS_UTC_OFFSET_MINUTES,
  defaultCurrency: 'NGN',
};

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

describe('parseAmount', () => {
  it.each([
    ['NGN5,000.00', 500_000n],
    ['₦5,000.00', 500_000n],
    ['N1,234.56', 123_456n],
    ['5000', 500_000n],
    ['0.05', 5n],
    ['  1,000.00 NGN  ', 100_000n],
  ])('parses %s as %s kobo', (raw, expected) => {
    expect(expectOk(parseAmount(raw, 'NGN')).minor).toBe(expected);
  });

  it('rejects precision the currency cannot hold, rather than rounding it away', () => {
    // Three decimals almost always means the pattern matched something else.
    expect(parseAmount('1.234', 'NGN').ok).toBe(false);
  });

  it.each(['', '   ', 'abc', 'NGN'])('rejects %s', (raw) => {
    expect(parseAmount(raw, 'NGN').ok).toBe(false);
  });
});

describe('parseCurrency', () => {
  it.each([
    ['NGN', 'NGN'],
    ['ngn', 'NGN'],
    ['₦', 'NGN'],
    ['USD', 'USD'],
    ['$', 'USD'],
  ])('maps %s to %s', (raw, expected) => {
    expect(expectOk(parseCurrency(raw))).toBe(expected);
  });

  it('rejects an unsupported currency instead of defaulting', () => {
    expect(parseCurrency('EUR').ok).toBe(false);
  });
});

describe('parseDirection', () => {
  it.each(['DR', 'Debit', 'debited', 'DEBIT:', 'withdrawal'])('reads %s as DEBIT', (raw) => {
    expect(expectOk(parseDirection(raw))).toBe('DEBIT');
  });

  it.each(['CR', 'Credit', 'credited', 'CR.', 'deposit'])('reads %s as CREDIT', (raw) => {
    expect(expectOk(parseDirection(raw))).toBe('CREDIT');
  });

  it('refuses to guess when the token is unrecognised', () => {
    expect(parseDirection('maybe').ok).toBe(false);
  });
});

describe('compileDateFormat', () => {
  it('requires a year, a month and a day', () => {
    expect(compileDateFormat('DD-MM').ok).toBe(false);
    expect(compileDateFormat('MM-YYYY').ok).toBe(false);
    expect(compileDateFormat('DD-YYYY').ok).toBe(false);
    expect(compileDateFormat('DD-MM-YYYY').ok).toBe(true);
  });

  it('rejects a repeated token, which is always an authoring mistake', () => {
    expect(compileDateFormat('DD-DD-YYYY').ok).toBe(false);
  });

  it('treats month and minute tokens as distinct', () => {
    expect(compileDateFormat('DD/MM/YYYY HH:mm').ok).toBe(true);
  });
});

describe('parseDateTime', () => {
  it.each([
    ['07-AUG-2026 14:23:45', 'DD-MMM-YYYY HH:mm:ss'],
    ['07-Aug-2026 14:23:45', 'DD-MMM-YYYY HH:mm:ss'],
    ['07/08/2026 14:23:45', 'DD/MM/YYYY HH:mm:ss'],
    ['2026-08-07 14:23:45', 'YYYY-MM-DD HH:mm:ss'],
    ['07/08/26 14:23:45', 'DD/MM/YY HH:mm:ss'],
  ])('parses %s with format %s to the same instant', (raw, format) => {
    // 14:23:45 Lagos time (UTC+1) is 13:23:45 UTC.
    expect(expectOk(parseDateTime(raw, format, lagos)).toISOString()).toBe(
      '2026-08-07T13:23:45.000Z',
    );
  });

  it('applies the institution offset — an hour of drift breaks day boundaries', () => {
    const utc = expectOk(
      parseDateTime('07-AUG-2026 00:30:00', 'DD-MMM-YYYY HH:mm:ss', {
        ...lagos,
        utcOffsetMinutes: 60,
      }),
    );

    // Half past midnight in Lagos is still the previous day in UTC. A ledger that
    // ignores this reports the transaction on the wrong day.
    expect(utc.toISOString()).toBe('2026-08-06T23:30:00.000Z');
  });

  it('defaults absent time components to midnight local', () => {
    expect(expectOk(parseDateTime('07-08-2026', 'DD-MM-YYYY', lagos)).toISOString()).toBe(
      '2026-08-06T23:00:00.000Z',
    );
  });

  it('rejects a date that does not exist rather than rolling it over', () => {
    // Date would silently turn 31 February into 3 March — a wrong transaction date.
    expect(parseDateTime('31/02/2026', 'DD/MM/YYYY', lagos).ok).toBe(false);
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseDateTime('29/02/2024', 'DD/MM/YYYY', lagos).ok).toBe(true);
    expect(parseDateTime('29/02/2026', 'DD/MM/YYYY', lagos).ok).toBe(false);
  });

  it.each([
    ['32/01/2026', 'day out of range'],
    ['07/13/2026', 'month out of range'],
    ['07/08/2026 25:00:00', 'hour out of range'],
    ['07/08/2026 12:61:00', 'minute out of range'],
  ])('rejects %s (%s)', (raw) => {
    const format = raw.includes(':') ? 'DD/MM/YYYY HH:mm:ss' : 'DD/MM/YYYY';
    expect(parseDateTime(raw, format, lagos).ok).toBe(false);
  });

  it('rejects text that does not match the declared format', () => {
    expect(parseDateTime('7 August 2026', 'DD/MM/YYYY', lagos).ok).toBe(false);
  });

  it('rejects an unknown month name', () => {
    expect(parseDateTime('07-XXX-2026', 'DD-MMM-YYYY', lagos).ok).toBe(false);
  });
});

describe('parseAccountLast4', () => {
  it.each([
    ['**1234', '1234'],
    ['XXXXXX1234', '1234'],
    ['0123456789', '6789'],
    ['Acct: **** 4321', '4321'],
  ])('extracts the last four digits of %s', (raw, expected) => {
    expect(expectOk(parseAccountLast4(raw))).toBe(expected);
  });

  it('rejects input without enough digits', () => {
    expect(parseAccountLast4('**12').ok).toBe(false);
  });
});
