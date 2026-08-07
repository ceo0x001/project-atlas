/**
 * Money formatting.
 *
 * Minor units arrive as decimal strings and are formatted without ever becoming a `number`.
 * ₦12,345,678.90 in kobo is 1234567890, which is well inside a double — but the habit is the
 * point: the moment a total is parsed as a float, the guarantee the whole backend maintains is
 * gone, and it will be gone silently.
 */

export function formatMoney(decimalString: string, currency: string): string {
  const negative = decimalString.startsWith('-');
  const [whole = '0', fraction = '00'] = decimalString.replace('-', '').split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'NGN' ? '₦' : currency === 'USD' ? '$' : `${currency} `;

  // Kobo are dropped when they are zero: nobody says "five thousand naira and zero kobo".
  const shown = fraction === '00' ? grouped : `${grouped}.${fraction}`;

  return `${negative ? '−' : ''}${symbol}${shown}`;
}

/** Formats minor units given as an integer string, e.g. a balance of "450000" -> ₦4,500. */
export function formatMinor(minorString: string, currency: string): string {
  const negative = minorString.startsWith('-');
  const digits = minorString.replace('-', '').padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);

  return formatMoney(`${negative ? '-' : ''}${whole}.${fraction}`, currency);
}

export function greeting(now: Date): string {
  const hour = now.getHours();

  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';

  return 'Good evening';
}
