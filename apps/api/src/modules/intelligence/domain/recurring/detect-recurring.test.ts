import { describe, expect, it } from 'vitest';
import type { CurrencyCode, MerchantId } from '@atlas/shared-kernel';
import { toId } from '@atlas/shared-kernel';
import {
  detectRecurringSeries,
  MIN_OCCURRENCES,
  normaliseNarration,
  type RecurringInput,
} from './detect-recurring';

const NGN = 'NGN' as CurrencyCode;

let seed = 0;

function txn(
  isoDate: string,
  amountMinor: bigint,
  description: string,
  overrides: Partial<RecurringInput> = {},
): RecurringInput {
  seed += 1;

  return {
    transactionId: toId<'TransactionId'>(`01KZTXN${String(seed).padStart(19, '0')}`),
    occurredAt: new Date(`${isoDate}T09:00:00.000Z`),
    amountMinor,
    currency: NGN,
    direction: 'DEBIT',
    description,
    merchantId: null,
    categoryId: null,
    ...overrides,
  };
}

/** Five months of an unchanging subscription — the clearest possible bill. */
const DSTV: readonly RecurringInput[] = [
  txn('2026-04-03', 2_450_000n, 'DSTV SUBSCRIPTION 8821'),
  txn('2026-05-03', 2_450_000n, 'DSTV SUBSCRIPTION 9134'),
  txn('2026-06-03', 2_450_000n, 'DSTV SUBSCRIPTION 2277'),
  txn('2026-07-03', 2_450_000n, 'DSTV SUBSCRIPTION 4410'),
  txn('2026-08-03', 2_450_000n, 'DSTV SUBSCRIPTION 6650'),
];

describe('finding a bill', () => {
  it('recognises an unchanging monthly subscription', () => {
    const [series, ...rest] = detectRecurringSeries(DSTV);

    expect(rest).toEqual([]);
    expect(series?.kind).toBe('BILL');
    expect(series?.cadence).toBe('MONTHLY');
    expect(series?.occurrences).toBe(5);
    expect(series?.expectedAmountMinor).toBe(2_450_000n);
    expect(series?.confidence).toBeGreaterThan(0.85);
  });

  /** Per-transaction reference numbers must not stop the payments grouping together. */
  it('groups payments whose narration carries a changing reference', () => {
    expect(detectRecurringSeries(DSTV)).toHaveLength(1);
  });

  it('projects the next occurrence on the same day of the month', () => {
    const [series] = detectRecurringSeries(DSTV);

    expect(series?.nextExpectedAt.toISOString().slice(0, 10)).toBe('2026-09-03');
  });

  /**
   * The reported amount must be one that actually occurred. An average would invent a figure no
   * payment ever had, and this number is read out as an expectation.
   */
  it('reports an amount that actually occurred, never an average', () => {
    const varied = [
      txn('2026-05-10', 1_000_000n, 'RENT'),
      txn('2026-06-10', 1_000_000n, 'RENT'),
      txn('2026-07-10', 1_050_000n, 'RENT'),
    ];

    const [series] = detectRecurringSeries(varied);
    const observed = varied.map((entry) => entry.amountMinor);

    expect(observed).toContain(series?.expectedAmountMinor);
  });

  it('groups on merchant identity when there is one', () => {
    const merchantId = toId<'MerchantId'>('01KZMER0000000000000000001') as MerchantId;
    const payments = [
      txn('2026-04-15', 500_000n, 'wildly different text', { merchantId }),
      txn('2026-05-15', 500_000n, 'nothing alike either', { merchantId }),
      txn('2026-06-15', 500_000n, 'again unrelated', { merchantId }),
    ];

    expect(detectRecurringSeries(payments)).toHaveLength(1);
  });
});

describe('bills, income and habits are different things', () => {
  it('calls incoming money income', () => {
    const salary = [
      txn('2026-05-28', 45_000_000n, 'SALARY', { direction: 'CREDIT' }),
      txn('2026-06-28', 45_000_000n, 'SALARY', { direction: 'CREDIT' }),
      txn('2026-07-28', 45_000_000n, 'SALARY', { direction: 'CREDIT' }),
    ];

    expect(detectRecurringSeries(salary)[0]?.kind).toBe('INCOME');
  });

  /**
   * The distinction that keeps the product from being annoying. Fuel most Fridays is a rhythm, not
   * an obligation — "you missed your Friday fuel" is noise, so it must not be classed as a bill.
   */
  it('calls a regular but variable outgoing a habit, not a bill', () => {
    const fuel = [
      txn('2026-07-03', 800_000n, 'FUEL STATION'),
      txn('2026-07-10', 1_500_000n, 'FUEL STATION'),
      txn('2026-07-17', 600_000n, 'FUEL STATION'),
      txn('2026-07-24', 1_200_000n, 'FUEL STATION'),
    ];

    const [series] = detectRecurringSeries(fuel);

    expect(series?.cadence).toBe('WEEKLY');
    expect(series?.kind).toBe('HABIT');
  });

  it('separates money going out from money coming in at the same payee', () => {
    const both = [
      txn('2026-05-05', 100_000n, 'ZENITH TRANSFER'),
      txn('2026-06-05', 100_000n, 'ZENITH TRANSFER'),
      txn('2026-07-05', 100_000n, 'ZENITH TRANSFER'),
      txn('2026-05-20', 300_000n, 'ZENITH TRANSFER', { direction: 'CREDIT' }),
      txn('2026-06-20', 300_000n, 'ZENITH TRANSFER', { direction: 'CREDIT' }),
      txn('2026-07-20', 300_000n, 'ZENITH TRANSFER', { direction: 'CREDIT' }),
    ];

    const kinds = detectRecurringSeries(both)
      .map((series) => series.kind)
      .sort();

    expect(kinds).toEqual(['BILL', 'INCOME']);
  });
});

describe('refusing to see patterns that are not there', () => {
  it(`needs at least ${MIN_OCCURRENCES} occurrences`, () => {
    const twice = [txn('2026-06-01', 500_000n, 'GYM'), txn('2026-07-01', 500_000n, 'GYM')];

    // Any two dates define an interval. Two payments is a coincidence, not a rhythm.
    expect(detectRecurringSeries(twice)).toEqual([]);
  });

  it('reports nothing for dates with no rhythm', () => {
    const scattered = [
      txn('2026-05-02', 500_000n, 'SUNDRY'),
      txn('2026-05-19', 500_000n, 'SUNDRY'),
      txn('2026-07-28', 500_000n, 'SUNDRY'),
      txn('2026-08-01', 500_000n, 'SUNDRY'),
    ];

    expect(detectRecurringSeries(scattered)).toEqual([]);
  });

  /**
   * Narrations are normalised hard enough to over-group, so unrelated card purchases end up in one
   * bucket. The arithmetic is what rejects them, not the string match — this pins that.
   */
  it('rejects a wrongly merged group because its numbers do not agree', () => {
    const generic = [
      txn('2026-07-02', 120_000n, 'POS PURCHASE 1234'),
      txn('2026-07-09', 4_500_000n, 'POS PURCHASE 5678'),
      txn('2026-07-15', 80_000n, 'POS PURCHASE 9012'),
      txn('2026-07-23', 2_000_000n, 'POS PURCHASE 3456'),
    ];

    // Roughly weekly, but the amounts range over fifty-fold. Nothing worth telling anyone.
    expect(detectRecurringSeries(generic)).toEqual([]);
  });

  it('ignores transactions whose narration carries no identity at all', () => {
    const anonymous = [
      txn('2026-05-01', 500_000n, '12345'),
      txn('2026-06-01', 500_000n, '67890'),
      txn('2026-07-01', 500_000n, '24680'),
    ];

    expect(detectRecurringSeries(anonymous)).toEqual([]);
  });

  it('does not group across currencies', () => {
    const mixed = [
      txn('2026-05-01', 500_000n, 'NETFLIX'),
      txn('2026-06-01', 500_000n, 'NETFLIX', { currency: 'USD' as CurrencyCode }),
      txn('2026-07-01', 500_000n, 'NETFLIX'),
    ];

    expect(detectRecurringSeries(mixed)).toEqual([]);
  });

  it('finds nothing in an empty history', () => {
    expect(detectRecurringSeries([])).toEqual([]);
  });
});

describe('cadences', () => {
  it.each([
    ['WEEKLY', ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24']],
    ['BIWEEKLY', ['2026-06-05', '2026-06-19', '2026-07-03', '2026-07-17']],
    ['MONTHLY', ['2026-05-08', '2026-06-08', '2026-07-08', '2026-08-08']],
    ['QUARTERLY', ['2025-11-12', '2026-02-12', '2026-05-12', '2026-08-12']],
    ['ANNUAL', ['2023-09-20', '2024-09-20', '2025-09-20']],
  ])('recognises a %s rhythm', (cadence, dates) => {
    const payments = dates.map((date) => txn(date, 900_000n, 'INSURANCE'));

    expect(detectRecurringSeries(payments)[0]?.cadence).toBe(cadence);
  });

  /**
   * February is 28 days and January is 31, so a bill on the same date each month has uneven gaps.
   * Measuring against the median absorbs that; measuring against a fixed 30 would not.
   */
  it('handles a bill on the same date across months of different lengths', () => {
    const dates = ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'];
    const payments = dates.map((date) => txn(date, 1_200_000n, 'SCHOOL FEES'));

    const [series] = detectRecurringSeries(payments);

    expect(series?.cadence).toBe('MONTHLY');
    expect(series?.confidence).toBeGreaterThan(0.8);
  });

  /**
   * A skipped month should cost confidence, not erase a bill paid many times. The gap is measured
   * against the median precisely so one doubled interval degrades rather than destroys.
   */
  it('survives a missed payment with reduced confidence', () => {
    const complete = ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05', '2026-07-05'].map(
      (date) => txn(date, 700_000n, 'INTERNET'),
    );
    const withGap = ['2026-03-05', '2026-04-05', '2026-06-05', '2026-07-05'].map((date) =>
      txn(date, 700_000n, 'INTERNET'),
    );

    const clean = detectRecurringSeries(complete)[0];
    const gapped = detectRecurringSeries(withGap)[0];

    expect(gapped?.cadence).toBe('MONTHLY');
    expect(gapped?.confidence).toBeLessThan(clean?.confidence ?? 1);
  });
});

describe('projecting the next one', () => {
  /** A bill due on the 31st must land on the 30th in a 30-day month, not spill into the next. */
  it('clamps a month-end bill to the length of the month', () => {
    const payments = ['2026-08-31', '2026-09-30', '2026-10-31'].map((date) =>
      txn(date, 1_000_000n, 'LOAN REPAYMENT'),
    );

    const [series] = detectRecurringSeries(payments);

    expect(series?.nextExpectedAt.toISOString().slice(0, 10)).toBe('2026-11-30');
  });

  it('adds days for weekly rhythms rather than doing calendar arithmetic', () => {
    const payments = ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24'].map((date) =>
      txn(date, 900_000n, 'CLEANER'),
    );

    expect(detectRecurringSeries(payments)[0]?.nextExpectedAt.toISOString().slice(0, 10)).toBe(
      '2026-07-31',
    );
  });

  /** One late payment must not drag the whole expectation with it. */
  it('uses the most common day of the month, not the latest', () => {
    const payments = [
      txn('2026-05-10', 800_000n, 'RENT'),
      txn('2026-06-10', 800_000n, 'RENT'),
      txn('2026-07-10', 800_000n, 'RENT'),
      txn('2026-08-14', 800_000n, 'RENT'),
    ];

    expect(detectRecurringSeries(payments)[0]?.nextExpectedAt.toISOString().slice(0, 10)).toBe(
      '2026-09-10',
    );
  });
});

describe('determinism', () => {
  /** Same history in, same answer out — whatever order it arrives in. */
  it('does not depend on input order', () => {
    const shuffled = [DSTV[2], DSTV[0], DSTV[4], DSTV[1], DSTV[3]].filter(
      (entry): entry is RecurringInput => entry !== undefined,
    );

    expect(detectRecurringSeries(shuffled)).toEqual(detectRecurringSeries(DSTV));
  });

  it('orders results most confident first', () => {
    const mixed = [
      ...DSTV,
      txn('2026-06-11', 300_000n, 'GYM'),
      txn('2026-07-09', 900_000n, 'GYM'),
      txn('2026-08-14', 500_000n, 'GYM'),
    ];

    const confidences = detectRecurringSeries(mixed).map((series) => series.confidence);

    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it('gives a payee the same key across runs, so re-detection updates rather than duplicates', () => {
    const first = detectRecurringSeries(DSTV)[0]?.key;
    const second = detectRecurringSeries([...DSTV].reverse())[0]?.key;

    expect(first).toBe(second);
    expect(first).toContain('DEBIT|NGN');
  });
});

describe('normaliseNarration', () => {
  it('strips the references that change every transaction', () => {
    expect(normaliseNarration('DSTV SUBSCRIPTION 8821')).toBe(
      normaliseNarration('DSTV SUBSCRIPTION 9134'),
    );
  });

  it.each([
    ['POS PURCHASE AT SHOPRITE/LAG/0912', 'pos purchase at shoprite lag'],
    ['  Netflix.com   ', 'netflix com'],
    ['TRF/FROM MUSA-123', 'trf from musa'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseNarration(input)).toBe(expected);
  });

  it.each([['12345'], [''], ['—'], ['ab']])('yields nothing usable for %s', (input) => {
    expect(normaliseNarration(input)).toBe('');
  });
});
