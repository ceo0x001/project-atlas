import { describe, expect, it } from 'vitest';
import { installBigIntSerializer } from './bigint';

describe('installBigIntSerializer', () => {
  it('serialises BigInt as a string, never a lossy number', () => {
    installBigIntSerializer();

    // 2^53 + 1 — the first integer a double cannot represent exactly.
    const beyondDoublePrecision = 9_007_199_254_740_993n;
    const json = JSON.stringify({ amountMinor: beyondDoublePrecision });

    expect(json).toBe('{"amountMinor":"9007199254740993"}');
    expect(JSON.parse(json).amountMinor).toBe('9007199254740993');
  });

  it('is idempotent, so repeated bootstraps are harmless', () => {
    installBigIntSerializer();
    installBigIntSerializer();

    expect(JSON.stringify({ value: 1n })).toBe('{"value":"1"}');
  });
});
