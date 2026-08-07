import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the money representation invariant at the schema level (ADR-003).
 *
 * The lint rule stops float arithmetic in application code, but nothing stops
 * someone declaring `amountMinor Float` in the schema — at which point Postgres
 * itself becomes the source of rounding error and every downstream guarantee is
 * void. This test is the backstop.
 */

const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');

/** Field declarations, ignoring comments and block syntax. */
function fieldDeclarations(): { line: string; name: string; type: string }[] {
  return schema
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('@@'))
    .map((line) => /^(\w+)\s+(\w+)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ line: match[0], name: match[1] as string, type: match[2] as string }));
}

describe('Prisma schema invariants', () => {
  it('never stores a monetary amount as Float or Decimal', () => {
    const offenders = fieldDeclarations().filter(
      (field) => /Minor$/.test(field.name) && field.type !== 'BigInt',
    );

    expect(offenders.map((field) => field.line)).toEqual([]);
  });

  it('has no Float fields outside the small set where approximation is acceptable', () => {
    // Confidence scores are statistical, not monetary; approximation is fine there.
    const allowedFloatFields = new Set(['confidence', 'categoryConfidence']);

    const offenders = fieldDeclarations().filter(
      (field) => field.type === 'Float' && !allowedFloatFields.has(field.name),
    );

    expect(offenders.map((field) => field.line)).toEqual([]);
  });

  it('declares no Decimal columns at all', () => {
    expect(fieldDeclarations().filter((field) => field.type === 'Decimal')).toEqual([]);
  });

  it('keeps the embedding dimension in step with the configured model', () => {
    // Changing one without the other silently breaks vector search.
    expect(schema).toContain('vector(1024)');
  });

  it('stores FX rates as an exact rational rather than a float', () => {
    expect(schema).toMatch(/rateNumerator\s+BigInt/);
    expect(schema).toMatch(/rateDenominator\s+BigInt/);
  });
});
