/**
 * Pulls the numeric claims out of an assistant response.
 *
 * This is the first half of the grounding gate (ADR-005): before a number can be
 * checked against what the tools actually returned, it has to be found and
 * classified. Getting that wrong in either direction is costly — a missed money
 * claim lets a hallucinated balance through, while a misclassified year makes the
 * gate reject a perfectly good answer and degrade it to canvas-only.
 *
 * So the extractor is deliberately conservative about what counts as a claim, and
 * explicit about what it skips.
 */

export type ClaimKind = 'money' | 'count' | 'percentage';

export interface NumericClaim {
  /** The span exactly as written, for reporting back in a verdict. */
  readonly text: string;
  readonly kind: ClaimKind;
  /** Absolute value as a plain decimal string, scale words already applied. */
  readonly normalised: string;
  readonly start: number;
  readonly end: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Spans that look numeric but are not claims about money. Skipping these is what
 * keeps the gate from flagging "August 2026" as an unverified figure.
 */
const IGNORED_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g, // ISO date
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // slash date
  /\b(?:19|20)\d{2}\b/g, // year
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, // clock time
  /\b\d+(?:st|nd|rd|th)\b/gi, // ordinal
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gi,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/gi,
];

/**
 * ₦45,200.15 · NGN 45,200 · NGN45200.15 · $1,234.56 · N45200 — a currency marker
 * then a number.
 *
 * No trailing `\b` after the codes: in "NGN45200" both sides of the boundary are
 * word characters, so `\bNGN\b` would never match the commonest way a model writes
 * an amount.
 */
const LEADING_CURRENCY = /(?:₦|\$|\bNGN|\bUSD|\bN(?=\d))\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?/gi;

/** 45,200.15 naira · 1.2m naira — a number then a currency word. */
const TRAILING_CURRENCY = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?\s*(?:naira|kobo|dollars?)\b/gi;

/** A decimal with exactly two places reads as money in a financial answer. */
const BARE_DECIMAL_MONEY = /\b(\d[\d,]*\.\d{2})\b/g;

/**
 * The word boundary belongs inside the alternation. `%\b` cannot match "12.5%."
 * because `%` and `.` are both non-word characters, so there is no boundary between
 * them — and a percentage at the end of a sentence is the normal case.
 */
const PERCENTAGE = /\b(\d+(?:\.\d+)?)\s*(?:%|\bper\s?cent\b)/gi;

/** Anything else that is a plain whole number is treated as a count. */
const BARE_INTEGER = /\b(\d[\d,]*)\b/g;

const SCALE_EXPONENTS: Readonly<Record<string, number>> = { k: 3, m: 6, bn: 9 };

/** Shifts a decimal string left by `places`, without touching a float. */
function shiftDecimalRight(value: string, places: number): string {
  if (places === 0) return value;

  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length <= places) {
    return whole + fraction.padEnd(places, '0');
  }

  return `${whole}${fraction.slice(0, places)}.${fraction.slice(places)}`;
}

function normalise(raw: string, scale: string | undefined): string {
  const digits = raw.replace(/,/g, '');
  const exponent = scale ? (SCALE_EXPONENTS[scale.toLowerCase()] ?? 0) : 0;

  return shiftDecimalRight(digits, exponent);
}

function overlaps(span: Span, taken: readonly Span[]): boolean {
  return taken.some((other) => span.start < other.end && other.start < span.end);
}

function collect(
  text: string,
  pattern: RegExp,
  kind: ClaimKind,
  taken: Span[],
  claims: NumericClaim[],
  hasScaleGroup: boolean,
): void {
  // Patterns are module-level and reused, so the cursor must be reset each pass.
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, taken)) continue;

    const amount = match[1];
    if (amount === undefined) continue;

    taken.push(span);
    claims.push({
      text: match[0].trim(),
      kind,
      normalised: normalise(amount, hasScaleGroup ? match[2] : undefined),
      start: span.start,
      end: span.end,
    });
  }
}

export function extractNumericClaims(text: string): readonly NumericClaim[] {
  const claims: NumericClaim[] = [];

  // Reserve the ignored spans first so later passes cannot claim them.
  const taken: Span[] = [];
  for (const pattern of IGNORED_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      taken.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  // Order matters: the most specific, least ambiguous forms claim their spans first.
  collect(text, LEADING_CURRENCY, 'money', taken, claims, true);
  collect(text, TRAILING_CURRENCY, 'money', taken, claims, true);
  collect(text, PERCENTAGE, 'percentage', taken, claims, false);
  collect(text, BARE_DECIMAL_MONEY, 'money', taken, claims, false);
  collect(text, BARE_INTEGER, 'count', taken, claims, false);

  return claims.sort((left, right) => left.start - right.start);
}
