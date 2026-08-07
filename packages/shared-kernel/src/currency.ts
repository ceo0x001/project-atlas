/**
 * Supported currencies (ADR-003).
 *
 * NGN and USD are both first-class from day 1: domiciliary accounts are common in
 * the target market, so multi-currency is a baseline requirement rather than an
 * edge case. Adding a currency is a data change here, never a schema change.
 */

const CURRENCY_REGISTRY = {
  NGN: { code: 'NGN', exponent: 2, symbol: '₦', name: 'Nigerian Naira' },
  USD: { code: 'USD', exponent: 2, symbol: '$', name: 'US Dollar' },
} as const;

export type CurrencyCode = keyof typeof CURRENCY_REGISTRY;

export interface Currency {
  readonly code: CurrencyCode;
  /** Decimal places in the minor unit: 2 for kobo/cents, 0 for JPY-style currencies. */
  readonly exponent: number;
  readonly symbol: string;
  readonly name: string;
}

/**
 * Keys stay narrow (so `CurrencyCode` is a precise union) while values are widened
 * to `Currency`. Without the widening, TypeScript infers `exponent: 2` from today's
 * registry and flags zero-decimal handling as dead code — which would quietly break
 * the moment a zero-decimal currency is added.
 */
export const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = CURRENCY_REGISTRY;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function getCurrency(code: CurrencyCode): Currency {
  return CURRENCIES[code];
}

/** Number of minor units in one major unit, e.g. 100 kobo in 1 naira. */
export function minorUnitsPerMajor(code: CurrencyCode): bigint {
  return 10n ** BigInt(CURRENCIES[code].exponent);
}
