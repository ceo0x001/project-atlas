import { type CurrencyCode, getCurrency, isCurrencyCode, minorUnitsPerMajor } from './currency';

/**
 * Money — the only sanctioned way to represent and compute with monetary values.
 *
 * Invariant I3 (ADR-003): amounts are integer minor units (kobo, cents) held as
 * bigint, paired with an ISO-4217 currency. There is deliberately no `toNumber()`
 * that yields a float for further arithmetic, because that is the exact mistake
 * this class exists to prevent. Rounding is always explicit.
 */

export type RoundingMode = 'HALF_EVEN' | 'HALF_UP' | 'FLOOR' | 'CEIL' | 'TRUNCATE';

/** Banker's rounding: the right default for money, unbiased over many operations. */
const DEFAULT_ROUNDING: RoundingMode = 'HALF_EVEN';

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(
      `Cannot combine ${left} with ${right}. Convert explicitly with a dated FX rate ` +
        `before aggregating across currencies.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Integer division with an explicit rounding policy. Operates on the magnitudes so
 * that FLOOR/CEIL mean "toward -inf / +inf" rather than "toward/away from zero".
 */
function divideWithRounding(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new InvalidMoneyError('Division by zero');
  }

  const isNegative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  if (remainder === 0n) {
    return isNegative ? -quotient : quotient;
  }

  const doubledRemainder = remainder * 2n;
  let magnitude: bigint;

  switch (mode) {
    case 'TRUNCATE':
      magnitude = quotient;
      break;
    case 'FLOOR':
      magnitude = isNegative ? quotient + 1n : quotient;
      break;
    case 'CEIL':
      magnitude = isNegative ? quotient : quotient + 1n;
      break;
    case 'HALF_UP':
      magnitude = doubledRemainder >= absDenominator ? quotient + 1n : quotient;
      break;
    case 'HALF_EVEN':
      if (doubledRemainder > absDenominator) {
        magnitude = quotient + 1n;
      } else if (doubledRemainder < absDenominator) {
        magnitude = quotient;
      } else {
        magnitude = quotient % 2n === 0n ? quotient : quotient + 1n;
      }
      break;
  }

  return isNegative ? -magnitude : magnitude;
}

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  // --- Construction -------------------------------------------------------

  /** Build from an exact minor-unit count (kobo, cents). */
  static of(minor: bigint | number, currency: CurrencyCode): Money {
    if (typeof minor === 'number') {
      if (!Number.isInteger(minor)) {
        throw new InvalidMoneyError(
          `Minor units must be an integer, received ${minor}. A fractional kobo means ` +
            `a rounding decision was made implicitly somewhere upstream.`,
        );
      }
      if (!Number.isSafeInteger(minor)) {
        throw new InvalidMoneyError(`Minor units ${minor} exceeds safe integer range; pass bigint`);
      }
    }
    return new Money(BigInt(minor), currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  /**
   * Parse a human/major-unit decimal string, e.g. "1,234.56" NGN -> 123456 kobo.
   * Rejects more precision than the currency supports rather than silently rounding
   * away the user's data.
   */
  static fromDecimalString(value: string, currency: CurrencyCode): Money {
    const cleaned = value.trim().replace(/[,\s_]/g, '');
    const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(cleaned);

    if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
      throw new InvalidMoneyError(`'${value}' is not a valid decimal amount`);
    }

    const [, sign = '', whole = '', fraction = ''] = match;
    const { exponent } = getCurrency(currency);

    if (fraction.length > exponent) {
      throw new InvalidMoneyError(
        `'${value}' has ${fraction.length} decimal places but ${currency} supports ` +
          `${exponent}. Round explicitly before constructing Money.`,
      );
    }

    const paddedFraction = fraction.padEnd(exponent, '0');
    const magnitude = BigInt((whole === '' ? '0' : whole) + paddedFraction);

    return new Money(sign === '-' ? -magnitude : magnitude, currency);
  }

  /** Rehydrate from the wire/database representation. */
  static fromJSON(value: { minor: string; currency: string }): Money {
    if (!isCurrencyCode(value.currency)) {
      throw new InvalidMoneyError(`Unsupported currency '${value.currency}'`);
    }
    return new Money(BigInt(value.minor), value.currency);
  }

  // --- Arithmetic ---------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  /** Multiply by an exact integer count (e.g. 3 identical charges). */
  timesInteger(factor: bigint | number): Money {
    if (typeof factor === 'number' && !Number.isInteger(factor)) {
      throw new InvalidMoneyError(
        `timesInteger requires an integer factor; use multiplyByRatio for fractions ` +
          `so the rounding mode is explicit.`,
      );
    }
    return new Money(this.minor * BigInt(factor), this.currency);
  }

  /**
   * Scale by a rational number with an explicit rounding policy — the only safe way
   * to apply rates, percentages, and FX conversion.
   */
  multiplyByRatio(
    numerator: bigint | number,
    denominator: bigint | number,
    rounding: RoundingMode = DEFAULT_ROUNDING,
  ): Money {
    return new Money(
      divideWithRounding(this.minor * BigInt(numerator), BigInt(denominator), rounding),
      this.currency,
    );
  }

  /** Percentage in basis points (1 bp = 0.01%), e.g. 750 bps = 7.5%. */
  percentageBps(basisPoints: bigint | number, rounding: RoundingMode = DEFAULT_ROUNDING): Money {
    return this.multiplyByRatio(basisPoints, 10_000n, rounding);
  }

  /**
   * Split across weights without losing or inventing a single minor unit.
   * Largest-remainder distribution: the sum of the parts always equals the whole.
   */
  allocate(weights: readonly (bigint | number)[]): Money[] {
    if (weights.length === 0) {
      throw new InvalidMoneyError('allocate requires at least one weight');
    }

    const bigWeights = weights.map((weight) => BigInt(weight));
    if (bigWeights.some((weight) => weight < 0n)) {
      throw new InvalidMoneyError('allocate weights must be non-negative');
    }

    const totalWeight = bigWeights.reduce((sum, weight) => sum + weight, 0n);
    if (totalWeight === 0n) {
      throw new InvalidMoneyError('allocate weights must not sum to zero');
    }

    // Truncate toward zero first, then hand out the remainder one unit at a time.
    const shares = bigWeights.map((weight) =>
      divideWithRounding(this.minor * weight, totalWeight, 'TRUNCATE'),
    );
    let remainder = this.minor - shares.reduce((sum, share) => sum + share, 0n);
    const step = remainder < 0n ? -1n : 1n;

    for (let index = 0; remainder !== 0n; index = (index + 1) % shares.length) {
      // Never hand a unit to a zero-weight participant.
      if (bigWeights[index] === 0n) continue;
      shares[index] = (shares[index] ?? 0n) + step;
      remainder -= step;
    }

    return shares.map((share) => new Money(share, this.currency));
  }

  // --- Comparison ---------------------------------------------------------

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  get isZero(): boolean {
    return this.minor === 0n;
  }

  get isNegative(): boolean {
    return this.minor < 0n;
  }

  get isPositive(): boolean {
    return this.minor > 0n;
  }

  // --- Aggregation --------------------------------------------------------

  /**
   * Sum a collection. Requires an explicit currency so that summing an empty list
   * returns a well-defined zero instead of throwing or guessing.
   */
  static sum(values: readonly Money[], currency: CurrencyCode): Money {
    return values.reduce<Money>((total, value) => total.plus(value), Money.zero(currency));
  }

  // --- Presentation -------------------------------------------------------

  /** Exact decimal representation, e.g. "-1234.56". Never lossy. */
  toDecimalString(): string {
    const { exponent } = getCurrency(this.currency);
    const divisor = minorUnitsPerMajor(this.currency);
    const magnitude = this.minor < 0n ? -this.minor : this.minor;
    const whole = magnitude / divisor;
    const fraction = magnitude % divisor;
    const sign = this.minor < 0n ? '-' : '';

    if (exponent === 0) return `${sign}${whole}`;
    return `${sign}${whole}.${fraction.toString().padStart(exponent, '0')}`;
  }

  /**
   * Localised display string, e.g. "₦1,234.56". Presentation only.
   *
   * Groups the integer part as a bigint so no intermediate float exists, then
   * appends the exact fraction. This trades full locale awareness of currency
   * symbol placement for exactness; correct for en-NG/en-US, revisit if we ever
   * localise into a currency-suffix locale.
   */
  format(locale = 'en-NG'): string {
    const { exponent, symbol } = getCurrency(this.currency);
    const divisor = minorUnitsPerMajor(this.currency);
    const magnitude = this.minor < 0n ? -this.minor : this.minor;
    const groupedWhole = new Intl.NumberFormat(locale).format(magnitude / divisor);
    const fraction = (magnitude % divisor).toString().padStart(exponent, '0');
    const sign = this.minor < 0n ? '-' : '';

    return exponent === 0
      ? `${sign}${symbol}${groupedWhole}`
      : `${sign}${symbol}${groupedWhole}.${fraction}`;
  }

  /** Database/wire form. minor is a string because JSON has no bigint. */
  toJSON(): { minor: string; currency: CurrencyCode } {
    return { minor: this.minor.toString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}
