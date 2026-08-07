import { idFromSeed, type TemplateId } from '@atlas/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPRESENTATIVE_SHAPES } from './__fixtures__/bank-shapes';
import type { ParseTemplate } from '../parse-template';
import { clearPatternCache, parseMessage, type SourceMessage } from './template-engine';
import { LAGOS_UTC_OFFSET_MINUTES, MAX_MESSAGE_LENGTH, type ParseContext } from './transforms';

const lagos: ParseContext = {
  utcOffsetMinutes: LAGOS_UTC_OFFSET_MINUTES,
  defaultCurrency: 'NGN',
};

function message(body: string, senderId = 'TESTBANK'): SourceMessage {
  return { senderId, body, receivedAt: new Date('2026-08-07T13:24:00Z') };
}

beforeEach(() => {
  clearPatternCache();
});

describe('parseMessage against the representative template shapes', () => {
  for (const { template, fixtures } of REPRESENTATIVE_SHAPES) {
    for (const [position, fixture] of fixtures.entries()) {
      it(`${template.name} fixture ${position} yields every declared field`, () => {
        const result = parseMessage(message(fixture.input), [template], lagos);

        if (!result.ok) throw new Error(`expected parse, got ${result.error.detail}`);
        const parsed = result.value;

        if (fixture.expected.amount) {
          expect(parsed.amount.toDecimalString()).toBe(fixture.expected.amount);
        }
        if (fixture.expected.direction) {
          expect(parsed.direction).toBe(fixture.expected.direction);
        }
        if (fixture.expected.occurredAt) {
          expect(parsed.occurredAt.toISOString()).toBe(fixture.expected.occurredAt);
        }
        if (fixture.expected.balanceAfter) {
          expect(parsed.balanceAfter?.toDecimalString()).toBe(fixture.expected.balanceAfter);
        }
        if (fixture.expected.description) {
          expect(parsed.description).toBe(fixture.expected.description);
        }
        if (fixture.expected.accountLast4) {
          expect(parsed.accountLast4).toBe(fixture.expected.accountLast4);
        }

        expect(parsed.templateId).toBe(template.id);
      });
    }
  }

  it('reads a direction the message never states, from a template literal', () => {
    const debitOnly = REPRESENTATIVE_SHAPES[2]!;
    const result = parseMessage(message(debitOnly.fixtures[0]!.input), [debitOnly.template], lagos);

    expect(result.ok && result.value.direction).toBe('DEBIT');
  });

  it('carries the balance the bank reported — the reconciliation anchor', () => {
    const labelled = REPRESENTATIVE_SHAPES[0]!;
    const result = parseMessage(message(labelled.fixtures[0]!.input), [labelled.template], lagos);

    expect(result.ok && result.value.balanceAfter?.toDecimalString()).toBe('45200.15');
  });
});

describe('template selection', () => {
  const base = REPRESENTATIVE_SHAPES[0]!.template;
  const body = REPRESENTATIVE_SHAPES[0]!.fixtures[0]!.input;

  it('prefers the highest version when several templates match', () => {
    const v2: ParseTemplate = { ...base, id: idFromSeed<'TemplateId'>(99), version: 2 };

    const result = parseMessage(message(body), [base, v2], lagos);

    expect(result.ok && result.value.templateId).toBe(v2.id);
  });

  it('is order-independent — selection is by version, not array position', () => {
    const v2: ParseTemplate = { ...base, id: idFromSeed<'TemplateId'>(99), version: 2 };

    const forwards = parseMessage(message(body), [base, v2], lagos);
    const backwards = parseMessage(message(body), [v2, base], lagos);

    expect(forwards.ok && forwards.value.templateId).toBe(
      backwards.ok ? backwards.value.templateId : ('mismatch' as TemplateId),
    );
  });
});

describe('parseMessage failure modes', () => {
  const labelled = REPRESENTATIVE_SHAPES[0]!.template;

  it('reports NO_TEMPLATE_MATCHED for an unrecognised format', () => {
    const result = parseMessage(
      message('Dear customer, your statement is ready.'),
      [labelled],
      lagos,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NO_TEMPLATE_MATCHED');
  });

  it('reports NO_TEMPLATE_MATCHED when there are no candidates at all', () => {
    expect(parseMessage(message('anything'), [], lagos).ok).toBe(false);
  });

  it('distinguishes a broken template from an unknown format', () => {
    // The pattern still matches, but the date format is wrong for the captured
    // text. That is a defect in a published template, not a new bank format, and
    // routing it to template synthesis would waste the flywheel.
    const broken: ParseTemplate = {
      ...labelled,
      fields: labelled.fields.map((field) =>
        field.kind === 'occurredAt' ? { ...field, format: 'YYYY-MM-DD' } : field,
      ),
    };

    const result = parseMessage(
      message(REPRESENTATIVE_SHAPES[0]!.fixtures[0]!.input),
      [broken],
      lagos,
    );

    expect(!result.ok && result.error.code).toBe('FIELD_EXTRACTION_FAILED');
    expect(!result.ok && result.error.attemptedTemplateId).toBe(broken.id);
  });

  it('does not fall through to an older version once a template has claimed a message', () => {
    // Falling through risks a different, subtly wrong reading of the same text.
    const brokenV2: ParseTemplate = {
      ...labelled,
      id: idFromSeed<'TemplateId'>(98),
      version: 2,
      fields: labelled.fields.map((field) =>
        field.kind === 'amount' ? { kind: 'amount' as const, group: 'nonexistent' } : field,
      ),
    };

    const result = parseMessage(
      message(REPRESENTATIVE_SHAPES[0]!.fixtures[0]!.input),
      [labelled, brokenV2],
      lagos,
    );

    expect(!result.ok && result.error.code).toBe('FIELD_EXTRACTION_FAILED');
  });

  it('refuses pathological input before it reaches the regex engine', () => {
    const result = parseMessage(message('x'.repeat(MAX_MESSAGE_LENGTH + 1)), [labelled], lagos);

    expect(!result.ok && result.error.code).toBe('MESSAGE_TOO_LONG');
  });
});

describe('field normalisation', () => {
  it('collapses the whitespace multi-line alerts leave in descriptions', () => {
    const labelled = REPRESENTATIVE_SHAPES[0]!.template;
    const body =
      'Acct: **1234\nAmt: NGN100.00 DR\nDesc: POS   PURCHASE\n   SHOPRITE\n' +
      'Time: 07-AUG-2026 10:00:00\nBal: NGN900.00';

    const result = parseMessage(message(body), [labelled], lagos);

    expect(result.ok && result.value.description).toBe('POS PURCHASE SHOPRITE');
  });

  it('falls back to the context currency when the template captures none', () => {
    const labelled = REPRESENTATIVE_SHAPES[0]!.template;
    const withoutCurrency: ParseTemplate = {
      ...labelled,
      fields: labelled.fields.filter((field) => field.kind !== 'currency'),
    };

    const result = parseMessage(
      message(REPRESENTATIVE_SHAPES[0]!.fixtures[0]!.input),
      [withoutCurrency],
      lagos,
    );

    expect(result.ok && result.value.currency).toBe('NGN');
  });
});
