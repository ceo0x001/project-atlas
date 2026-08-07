import { describe, expect, it } from 'vitest';
import { REPRESENTATIVE_SHAPES } from './__fixtures__/bank-shapes';
import type { ParseTemplate, TemplateFixture } from '../parse-template';
import { findNestedQuantifiers, namedGroupsOf, validateTemplate } from './template-validator';
import { LAGOS_UTC_OFFSET_MINUTES, type ParseContext } from './transforms';

const lagos: ParseContext = {
  utcOffsetMinutes: LAGOS_UTC_OFFSET_MINUTES,
  defaultCurrency: 'NGN',
};

const base = REPRESENTATIVE_SHAPES[0]!.template;
const baseFixtures = REPRESENTATIVE_SHAPES[0]!.fixtures;

function defectCodes(template: ParseTemplate, fixtures: readonly TemplateFixture[] = baseFixtures) {
  return validateTemplate(template, fixtures, lagos).defects.map((defect) => defect.code);
}

describe('findNestedQuantifiers', () => {
  it.each([
    ['(\\d+)+', 'classic exponential backtracking'],
    ['([a-z]+)*', 'quantified group of a quantified class'],
    ['(?:\\w+)+', 'non-capturing group is no safer'],
    ['(a{2,})+', 'brace quantifier inside a quantified group'],
  ])('flags %s (%s)', (pattern) => {
    expect(findNestedQuantifiers(pattern).length).toBeGreaterThan(0);
  });

  it.each([
    ['\\d+', 'a bare quantifier is fine'],
    ['(a|b)*', 'alternation without an inner quantifier is linear'],
    ['(abc)+', 'a quantified literal group is fine'],
    ['([+*])+', 'quantifier characters inside a character class are literals'],
    ['(?<amt>[\\d,]+\\.\\d{2})', 'an unquantified capture group is fine'],
  ])('accepts %s (%s)', (pattern) => {
    expect(findNestedQuantifiers(pattern)).toEqual([]);
  });
});

describe('namedGroupsOf', () => {
  it('collects declared capture group names', () => {
    expect(namedGroupsOf('(?<amt>\\d+)-(?<cur>[A-Z]{3})')).toEqual(new Set(['amt', 'cur']));
  });

  it('does not mistake lookbehind for a named group', () => {
    expect(namedGroupsOf('(?<=NGN)(?<amt>\\d+)')).toEqual(new Set(['amt']));
    expect(namedGroupsOf('(?<!X)\\d+')).toEqual(new Set());
  });
});

describe('validateTemplate accepts sound templates', () => {
  it.each(REPRESENTATIVE_SHAPES.map((seed) => [seed.template.name, seed] as const))(
    'shape %s passes the publication gate',
    (_name, seed) => {
      const result = validateTemplate(seed.template, seed.fixtures, lagos);

      expect(result.defects).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.fixturesPassed).toBe(seed.fixtures.length);
    },
  );
});

describe('validateTemplate rejects unsafe patterns', () => {
  it('refuses a pattern that could pin a phone CPU', () => {
    const unsafe: ParseTemplate = { ...base, matchPattern: '(?<amt>(\\d+)+)' };

    expect(defectCodes(unsafe)).toContain('PATTERN_UNSAFE');
  });

  it('refuses backreferences', () => {
    const unsafe: ParseTemplate = { ...base, matchPattern: '(?<amt>\\d+)\\1' };

    expect(defectCodes(unsafe)).toContain('PATTERN_UNSAFE');
  });

  it('refuses an over-long pattern no human will review', () => {
    const unsafe: ParseTemplate = { ...base, matchPattern: `(?<amt>${'a'.repeat(2100)})` };

    expect(defectCodes(unsafe)).toContain('PATTERN_UNSAFE');
  });

  it('refuses a pattern that does not compile', () => {
    const broken: ParseTemplate = { ...base, matchPattern: '(?<amt>[unclosed' };

    expect(defectCodes(broken)).toContain('PATTERN_INVALID');
  });
});

describe('validateTemplate rejects malformed field wiring', () => {
  it('refuses a field pointing at a group the pattern never declares', () => {
    const broken: ParseTemplate = {
      ...base,
      fields: [...base.fields, { kind: 'description', group: 'nope' }],
    };

    expect(defectCodes(broken)).toContain('UNKNOWN_GROUP');
  });

  it('refuses a field that declares both a group and a literal', () => {
    const broken: ParseTemplate = {
      ...base,
      fields: base.fields.map((field) =>
        field.kind === 'direction' ? { ...field, literal: 'DR' } : field,
      ),
    };

    expect(defectCodes(broken)).toContain('FIELD_SOURCE_AMBIGUOUS');
  });

  it('refuses a field that declares neither', () => {
    const broken: ParseTemplate = { ...base, fields: [...base.fields, { kind: 'description' }] };

    expect(defectCodes(broken)).toContain('FIELD_SOURCE_AMBIGUOUS');
  });

  it.each(['amount', 'direction', 'occurredAt'] as const)(
    'refuses a template with no %s field',
    (kind) => {
      const broken: ParseTemplate = {
        ...base,
        fields: base.fields.filter((field) => field.kind !== kind),
      };

      expect(defectCodes(broken)).toContain('MISSING_REQUIRED_FIELD');
    },
  );

  it('refuses a date field with no explicit format', () => {
    const broken: ParseTemplate = {
      ...base,
      fields: base.fields.map((field) => {
        if (field.kind !== 'occurredAt') return field;
        // Omit `format` entirely rather than setting it undefined —
        // exactOptionalPropertyTypes treats those as different things.
        const { format: _omitted, ...withoutFormat } = field;
        return withoutFormat;
      }),
    };

    expect(defectCodes(broken)).toContain('MISSING_DATE_FORMAT');
  });
});

describe('validateTemplate enforces the fixture gate', () => {
  it('refuses a template with no fixtures', () => {
    expect(defectCodes(base, [])).toContain('FIXTURE_FAILED');
  });

  it('catches a template that reads the balance where the amount should be', () => {
    // The subtle, dangerous defect: it parses cleanly and produces a wrong ledger.
    const swapped: ParseTemplate = {
      ...base,
      fields: base.fields.map((field) => {
        if (field.kind === 'amount') return { kind: 'amount' as const, group: 'bal' };
        if (field.kind === 'balanceAfter') return { kind: 'balanceAfter' as const, group: 'amt' };
        return field;
      }),
    };

    const result = validateTemplate(swapped, baseFixtures, lagos);

    expect(result.valid).toBe(false);
    expect(result.defects.some((defect) => defect.detail.includes('amount'))).toBe(true);
  });

  it('catches a date format that is plausible but wrong', () => {
    // DD/MM vs MM/DD reads 07-08 as August 7th or July 8th. Both parse.
    const swapped: ParseTemplate = {
      ...REPRESENTATIVE_SHAPES[1]!.template,
      fields: REPRESENTATIVE_SHAPES[1]!.template.fields.map((field) =>
        field.kind === 'occurredAt' ? { ...field, format: 'MM/DD/YYYY' } : field,
      ),
    };

    const result = validateTemplate(swapped, REPRESENTATIVE_SHAPES[1]!.fixtures, lagos);

    expect(result.valid).toBe(false);
    expect(result.defects.map((defect) => defect.code)).toContain('FIXTURE_FAILED');
  });

  it('reports how many fixtures passed, for flywheel telemetry', () => {
    const result = validateTemplate(base, baseFixtures, lagos);

    expect(result.fixturesPassed).toBe(baseFixtures.length);
    expect(result.fixturesTotal).toBe(baseFixtures.length);
  });
});
