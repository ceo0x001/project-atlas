import { describe, expect, it } from 'vitest';
import { extractNumericClaims } from './claim-extraction';
import { NumericGroundingGate } from './numeric-grounding-gate';
import type { GroundingFact } from './tool';

const gate = new NumericGroundingGate();

const money = (value: string, label = 'total'): GroundingFact => ({ label, value, kind: 'money' });
const count = (value: string, label = 'count'): GroundingFact => ({ label, value, kind: 'count' });
const percentage = (value: string): GroundingFact => ({
  label: 'change',
  value,
  kind: 'percentage',
});

describe('claim extraction', () => {
  it.each([
    ['You spent ₦45,200.15 last month.', '45200.15'],
    ['You spent NGN 45,200.15 last month.', '45200.15'],
    ['You spent N45200 last month.', '45200'],
    ['You spent $1,234.56 last month.', '1234.56'],
    ['You spent 45,200.15 naira.', '45200.15'],
    ['That is 45,200.15 in total.', '45200.15'],
  ])('finds the amount in %s', (text, expected) => {
    const claims = extractNumericClaims(text);

    expect(claims.some((claim) => claim.kind === 'money' && claim.normalised === expected)).toBe(
      true,
    );
  });

  it('expands scale suffixes without touching a float', () => {
    expect(extractNumericClaims('about ₦45k')[0]!.normalised).toBe('45000');
    expect(extractNumericClaims('about ₦1.25m')[0]!.normalised).toBe('1250000');
  });

  it('ignores dates, years, times and ordinals', () => {
    const text =
      'On 2026-08-07 at 14:23, your 3rd payment of ₦500.00 in August 2026 cleared on 07/08/2026.';

    const claims = extractNumericClaims(text);

    // Only the amount is a claim; every other number is calendar or clock noise.
    expect(claims.filter((claim) => claim.kind === 'money')).toHaveLength(1);
    expect(claims.find((claim) => claim.kind === 'money')!.normalised).toBe('500.00');
    expect(claims.some((claim) => claim.normalised === '2026')).toBe(false);
  });

  it('reads a percentage as a percentage, not as money', () => {
    const claims = extractNumericClaims('Spending is up 12.5% on last month.');

    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe('percentage');
  });

  it('treats a bare whole number as a count', () => {
    const claims = extractNumericClaims('You made 47 transactions.');

    expect(claims[0]!.kind).toBe('count');
    expect(claims[0]!.normalised).toBe('47');
  });

  it('never double-counts a span', () => {
    // '45,200.15' must be one money claim, not also a count of 45.
    expect(extractNumericClaims('₦45,200.15')).toHaveLength(1);
  });
});

describe('exact grounding', () => {
  it('passes a response with no numbers at all', () => {
    const verdict = gate.verify('I could not find any spending in that period.', []);

    expect(verdict.grounded).toBe(true);
    expect(verdict.claimsChecked).toBe(0);
  });

  it('passes an exact restatement', () => {
    const verdict = gate.verify('You spent ₦45,200.15 in August.', [money('45200.15')]);

    expect(verdict.grounded).toBe(true);
    expect(verdict.claimsChecked).toBe(1);
  });

  it('passes the same value written differently', () => {
    for (const text of ['₦45,200.15', 'NGN45200.15', '45,200.15 naira', '45200.15']) {
      expect(gate.verify(`You spent ${text}.`, [money('45200.15')]).grounded).toBe(true);
    }
  });
});

describe('the rounding rule', () => {
  const facts = [money('45200.15')];

  it.each([
    ['45,200.15', 'exact'],
    ['45,200', 'five significant figures'],
    ['45,000', 'two significant figures'],
    ['45k', 'two significant figures, abbreviated'],
  ])('accepts ₦%s (%s)', (written) => {
    expect(gate.verify(`You spent about ₦${written}.`, facts).grounded).toBe(true);
  });

  it.each([
    ['50,000', 'one significant figure is not rounding'],
    ['46,000', 'not a rounding of the fact'],
    ['45,500', 'not a rounding of the fact'],
    ['452,000', 'off by a factor of ten'],
    ['4,520', 'off by a factor of ten'],
  ])('rejects ₦%s (%s)', (written) => {
    const verdict = gate.verify(`You spent about ₦${written}.`, facts);

    expect(verdict.grounded).toBe(false);
    expect(verdict.unverifiedClaims[0]!.reason).toBe('VALUE_MISMATCH');
  });

  it('rounds half up, consistently with how a person would', () => {
    // 1,250 to two significant figures is 1,300.
    expect(gate.verify('About ₦1,300.', [money('1250')]).grounded).toBe(true);
  });

  it('permits an exact zero and nothing near it', () => {
    expect(gate.verify('You spent ₦0.00.', [money('0.00')]).grounded).toBe(true);
    expect(gate.verify('You spent ₦100.00.', [money('0.00')]).grounded).toBe(false);
  });
});

describe('fabrication is caught', () => {
  it('rejects any number when the tools returned nothing', () => {
    // The critical case: the model answers confidently without calling a tool.
    const verdict = gate.verify('Your balance is ₦120,000.00.', []);

    expect(verdict.grounded).toBe(false);
    expect(verdict.unverifiedClaims[0]!.reason).toBe('NO_MATCHING_FACT');
    expect(verdict.unverifiedClaims[0]!.nearestFact).toBeUndefined();
  });

  it('catches one invented figure among several true ones', () => {
    const verdict = gate.verify(
      'You spent ₦45,200.15 on food and ₦12,000.00 on transport, so ₦99,999.00 in total.',
      [money('45200.15', 'food'), money('12000.00', 'transport')],
    );

    expect(verdict.grounded).toBe(false);
    expect(verdict.claimsChecked).toBe(3);
    expect(verdict.unverifiedClaims).toHaveLength(1);
    expect(verdict.unverifiedClaims[0]!.claim).toContain('99,999');
  });

  it('names the nearest fact, so a prompt regression is debuggable', () => {
    const verdict = gate.verify('You spent ₦46,000.00.', [money('45200.15', 'august-total')]);

    expect(verdict.unverifiedClaims[0]!.nearestFact?.label).toBe('august-total');
  });

  it('will not let a money claim be satisfied by a count fact', () => {
    // 47 transactions must not license "₦47.00".
    const verdict = gate.verify('You spent ₦47.00.', [count('47')]);

    expect(verdict.grounded).toBe(false);
  });

  it('will not let a count be satisfied by a money fact', () => {
    const verdict = gate.verify('You made 45 transactions.', [money('45.00')]);

    expect(verdict.grounded).toBe(false);
  });
});

describe('percentages and counts', () => {
  it('verifies a percentage against a percentage fact', () => {
    expect(gate.verify('Spending is up 12.5%.', [percentage('12.5')]).grounded).toBe(true);
    expect(gate.verify('Spending is up 40%.', [percentage('12.5')]).grounded).toBe(false);
  });

  it('verifies a count exactly for small numbers', () => {
    expect(gate.verify('You made 47 transactions.', [count('47')]).grounded).toBe(true);
    // Two significant figures of 47 is 47, so "about 50" is not a valid rounding.
    expect(gate.verify('You made about 50 transactions.', [count('47')]).grounded).toBe(false);
  });

  it('permits a sensible rounding of a large count', () => {
    expect(gate.verify('You made about 1,200 transactions.', [count('1234')]).grounded).toBe(true);
  });
});

describe('sign handling', () => {
  it('matches a spoken magnitude against a negative fact', () => {
    // A credit may be stored negative; the user still hears the magnitude.
    expect(gate.verify('You received ₦45,200.15.', [money('-45200.15')]).grounded).toBe(true);
  });

  it("does not attempt to verify direction — that is the canvas's job", () => {
    // Both readings are numerically grounded. Semantic correctness comes from the
    // tool payload and the rendered evidence, not from this gate.
    expect(gate.verify('You spent ₦45,200.15.', [money('45200.15')]).grounded).toBe(true);
    expect(gate.verify('You received ₦45,200.15.', [money('45200.15')]).grounded).toBe(true);
  });
});
