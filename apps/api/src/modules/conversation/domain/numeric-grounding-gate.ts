import { extractNumericClaims, type NumericClaim } from './claim-extraction';
import type { GroundingGate, GroundingVerdict, UnverifiedClaim } from './grounding';
import type { GroundingFact, GroundingFactKind } from './tool';

/**
 * The grounding gate (ADR-005, invariant I1).
 *
 * Every number in an assistant response must trace to a value a tool actually
 * returned. Anything else is a hallucination, however plausible.
 *
 * ## The rounding problem, and the rule that solves it
 *
 * Strict equality would make Atlas sound like a machine. A real CFO says "about
 * forty-five thousand", not "forty-five thousand two hundred naira and fifteen
 * kobo" — and for a voice product that difference is most of the experience.
 *
 * But any *tolerance* is a licence to fabricate: at 10%, a true balance of ₦45,200
 * would accept a claim of ₦50,000.
 *
 * So the rule is not a tolerance. A claim is grounded if it is either exactly a
 * declared fact, or a **correct rounding of that fact to at least two significant
 * figures**:
 *
 *   fact ₦45,200.15  →  accepts 45200.15, 45200, 45000
 *                    →  rejects 50000 (one significant figure), 46000, 45500
 *
 * That permits every rounding a person would naturally make while refusing every
 * value that is not actually derived from the data. It is also explainable: the
 * verdict can always say which fact a claim was checked against.
 *
 * ## What this gate does not do
 *
 * It verifies magnitudes, not meaning. "You received ₦45,200" and "you spent
 * ₦45,200" are equally grounded. Direction, category and period correctness come
 * from the tool payload and the canvas, which render from raw query results without
 * passing through the model at all.
 */

/** Decimal places used for exact integer comparison. Four is beyond any currency. */
const COMPARISON_SCALE = 4;

/** One significant figure is where rounding stops being rounding. */
const MINIMUM_SIGNIFICANT_FIGURES = 2;

/** Parses a plain decimal string into a fixed-scale integer. Null if unparseable. */
function toScaled(decimal: string): bigint | null {
  const cleaned = decimal.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;

  const [whole = '0', fraction = ''] = cleaned.split('.');
  if (fraction.length > COMPARISON_SCALE) {
    // More precision than any supported currency carries; compare what fits.
    return BigInt(whole + fraction.slice(0, COMPARISON_SCALE));
  }

  return BigInt(whole + fraction.padEnd(COMPARISON_SCALE, '0'));
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;

  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/**
 * Every value a fact may legitimately be restated as.
 *
 * Scaling by a power of ten does not change significant figures, so this operates
 * directly on the scaled integer.
 */
function acceptableRenderings(scaled: bigint): Set<bigint> {
  const accepted = new Set<bigint>([scaled]);

  if (scaled === 0n) return accepted;

  const digits = scaled.toString().length;

  for (let sigFigs = MINIMUM_SIGNIFICANT_FIGURES; sigFigs < digits; sigFigs += 1) {
    const divisor = 10n ** BigInt(digits - sigFigs);
    accepted.add(roundHalfUp(scaled, divisor) * divisor);
  }

  return accepted;
}

/** Claim kinds map onto fact kinds; dates are not numerically verified. */
const KIND_MATCHES: Readonly<Record<NumericClaim['kind'], GroundingFactKind>> = {
  money: 'money',
  count: 'count',
  percentage: 'percentage',
};

interface PreparedFact {
  readonly fact: GroundingFact;
  readonly scaled: bigint;
  readonly accepted: Set<bigint>;
}

export class NumericGroundingGate implements GroundingGate {
  verify(responseText: string, facts: readonly GroundingFact[]): GroundingVerdict {
    const claims = extractNumericClaims(responseText);

    if (claims.length === 0) {
      return { grounded: true, unverifiedClaims: [], claimsChecked: 0 };
    }

    const prepared = this.prepare(facts);
    const unverifiedClaims: UnverifiedClaim[] = [];

    for (const claim of claims) {
      const scaled = toScaled(claim.normalised);

      if (scaled === null) {
        unverifiedClaims.push({ claim: claim.text, reason: 'NO_MATCHING_FACT' });
        continue;
      }

      const candidates = prepared.filter((entry) => entry.fact.kind === KIND_MATCHES[claim.kind]);
      const isGrounded = candidates.some((entry) => entry.accepted.has(scaled));

      if (isGrounded) continue;

      const nearest = this.nearest(candidates, scaled);

      unverifiedClaims.push({
        claim: claim.text,
        // A near miss is a rounding or transcription error; no candidate at all
        // means the model produced a number from nowhere.
        reason: nearest ? 'VALUE_MISMATCH' : 'NO_MATCHING_FACT',
        ...(nearest ? { nearestFact: nearest } : {}),
      });
    }

    return {
      grounded: unverifiedClaims.length === 0,
      unverifiedClaims,
      claimsChecked: claims.length,
    };
  }

  private prepare(facts: readonly GroundingFact[]): readonly PreparedFact[] {
    const prepared: PreparedFact[] = [];

    for (const fact of facts) {
      // Facts are canonical strings from tool results; a negative money value is
      // still the same magnitude a user would hear spoken.
      const scaled = toScaled(fact.value.replace(/^-/, ''));
      if (scaled === null) continue;

      prepared.push({ fact, scaled, accepted: acceptableRenderings(scaled) });
    }

    return prepared;
  }

  private nearest(candidates: readonly PreparedFact[], scaled: bigint): GroundingFact | undefined {
    let best: PreparedFact | undefined;
    let bestDistance: bigint | undefined;

    for (const candidate of candidates) {
      const difference =
        candidate.scaled > scaled ? candidate.scaled - scaled : scaled - candidate.scaled;

      if (bestDistance === undefined || difference < bestDistance) {
        best = candidate;
        bestDistance = difference;
      }
    }

    return best?.fact;
  }
}
