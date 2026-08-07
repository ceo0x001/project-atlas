import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const ngn = (minor: bigint | number) => Money.of(minor, 'NGN');

describe('Money construction', () => {
  it('holds exact minor units', () => {
    expect(ngn(123456n).minor).toBe(123456n);
    expect(Money.zero('NGN').minor).toBe(0n);
  });

  it('rejects fractional minor units, because a fractional kobo hides a rounding decision', () => {
    expect(() => ngn(10.5)).toThrow(InvalidMoneyError);
  });

  it('rejects numbers beyond safe integer range', () => {
    expect(() => ngn(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
  });

  it('survives amounts far beyond Number.MAX_SAFE_INTEGER as bigint', () => {
    const huge = 9_007_199_254_740_993n * 1000n;
    expect(ngn(huge).plus(ngn(1n)).minor).toBe(huge + 1n);
  });
});

describe('Money.fromDecimalString', () => {
  it.each([
    ['1234.56', 123456n],
    ['1,234.56', 123456n],
    ['5', 500n],
    ['.5', 50n],
    ['-12.5', -1250n],
    ['+7.05', 705n],
    ['0.00', 0n],
  ])('parses %s to %s kobo', (input, expected) => {
    expect(Money.fromDecimalString(input, 'NGN').minor).toBe(expected);
  });

  it('rejects more precision than the currency supports rather than silently rounding', () => {
    expect(() => Money.fromDecimalString('1.234', 'NGN')).toThrow(InvalidMoneyError);
  });

  it.each(['', '.', 'abc', '1.2.3', '1 000.00.'])('rejects malformed input %s', (input) => {
    expect(() => Money.fromDecimalString(input, 'NGN')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(ngn(150n).plus(ngn(275n)).minor).toBe(425n);
    expect(ngn(150n).minus(ngn(275n)).minor).toBe(-125n);
  });

  it('refuses to mix currencies (invariant I3)', () => {
    expect(() => ngn(100n).plus(Money.of(100n, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => ngn(100n).compare(Money.of(100n, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('negates and takes absolute value', () => {
    expect(ngn(-500n).abs().minor).toBe(500n);
    expect(ngn(500n).negate().minor).toBe(-500n);
  });

  it('multiplies by an integer count', () => {
    expect(ngn(250n).timesInteger(3).minor).toBe(750n);
  });

  it('refuses a fractional factor, forcing an explicit rounding mode', () => {
    expect(() => ngn(250n).timesInteger(1.5)).toThrow(InvalidMoneyError);
  });

  it('applies basis points', () => {
    expect(ngn(10_000n).percentageBps(750).minor).toBe(750n);
  });

  it('avoids float drift that plagues naive implementations', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; in minor units it is simply 10 + 20 = 30.
    const sum = Money.fromDecimalString('0.10', 'NGN').plus(Money.fromDecimalString('0.20', 'NGN'));
    expect(sum.toDecimalString()).toBe('0.30');
  });
});

describe('Money rounding modes', () => {
  // 5 kobo halved is exactly 2.5 kobo — the tie case every mode disagrees on.
  it.each([
    ['HALF_EVEN', 2n],
    ['HALF_UP', 3n],
    ['FLOOR', 2n],
    ['CEIL', 3n],
    ['TRUNCATE', 2n],
  ] as const)('%s rounds +2.5 to %s', (mode, expected) => {
    expect(ngn(5n).multiplyByRatio(1, 2, mode).minor).toBe(expected);
  });

  it.each([
    ['HALF_EVEN', -2n],
    ['HALF_UP', -3n],
    ['FLOOR', -3n],
    ['CEIL', -2n],
    ['TRUNCATE', -2n],
  ] as const)('%s rounds -2.5 to %s', (mode, expected) => {
    expect(ngn(-5n).multiplyByRatio(1, 2, mode).minor).toBe(expected);
  });

  it("banker's rounding breaks ties toward even, staying unbiased", () => {
    expect(ngn(5n).multiplyByRatio(1, 2).minor).toBe(2n); // 2.5 -> 2 (even)
    expect(ngn(15n).multiplyByRatio(1, 2).minor).toBe(8n); // 7.5 -> 8 (even)
  });
});

describe('Money.allocate', () => {
  it('never loses a kobo when a split does not divide evenly', () => {
    const parts = ngn(100n).allocate([1, 1, 1]);
    expect(parts.map((part) => part.minor)).toEqual([34n, 33n, 33n]);
    expect(Money.sum(parts, 'NGN').minor).toBe(100n);
  });

  it('respects weights', () => {
    expect(
      ngn(100n)
        .allocate([3, 1])
        .map((part) => part.minor),
    ).toEqual([75n, 25n]);
  });

  it('handles negative totals without inventing units', () => {
    const parts = ngn(-100n).allocate([1, 1, 1]);
    expect(parts.map((part) => part.minor)).toEqual([-34n, -33n, -33n]);
    expect(Money.sum(parts, 'NGN').minor).toBe(-100n);
  });

  it('never hands a remainder unit to a zero-weight participant', () => {
    const parts = ngn(101n).allocate([1, 0, 1]);
    expect(parts.map((part) => part.minor)).toEqual([51n, 0n, 50n]);
    expect(Money.sum(parts, 'NGN').minor).toBe(101n);
  });

  it.each([[[]], [[0, 0]], [[1, -1]]])('rejects invalid weights %j', (weights) => {
    expect(() => ngn(100n).allocate(weights)).toThrow(InvalidMoneyError);
  });
});

describe('Money comparison and aggregation', () => {
  it('compares and tests sign', () => {
    expect(ngn(100n).greaterThan(ngn(50n))).toBe(true);
    expect(ngn(50n).lessThan(ngn(100n))).toBe(true);
    expect(ngn(100n).equals(ngn(100n))).toBe(true);
    expect(ngn(100n).equals(Money.of(100n, 'USD'))).toBe(false);
    expect(Money.zero('NGN').isZero).toBe(true);
    expect(ngn(-1n).isNegative).toBe(true);
    expect(ngn(1n).isPositive).toBe(true);
  });

  it('sums an empty list to a well-defined zero', () => {
    expect(Money.sum([], 'NGN').minor).toBe(0n);
  });

  it('sums a list exactly', () => {
    expect(Money.sum([ngn(100n), ngn(250n), ngn(-50n)], 'NGN').minor).toBe(300n);
  });
});

describe('Money presentation and serialisation', () => {
  it.each([
    [123456n, '1234.56'],
    [100n, '1.00'],
    [5n, '0.05'],
    [-5n, '-0.05'],
    [0n, '0.00'],
  ])('renders %s kobo as %s', (minor, expected) => {
    expect(ngn(minor).toDecimalString()).toBe(expected);
  });

  it('formats for display without a float round-trip', () => {
    expect(ngn(123456n).format('en-NG')).toContain('1,234.56');
  });

  it('round-trips through JSON', () => {
    const original = ngn(-98765n);
    expect(Money.fromJSON(original.toJSON()).equals(original)).toBe(true);
  });

  it('rejects an unknown currency on rehydration', () => {
    expect(() => Money.fromJSON({ minor: '1', currency: 'XYZ' })).toThrow(InvalidMoneyError);
  });

  it('is immutable', () => {
    const amount = ngn(100n);
    amount.plus(ngn(50n));
    expect(amount.minor).toBe(100n);
    expect(Object.isFrozen(amount)).toBe(true);
  });
});
