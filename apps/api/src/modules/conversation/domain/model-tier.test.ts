import { describe, expect, it } from 'vitest';
import { costMicroUsd, profileFor } from './model-tier';

describe('profileFor', () => {
  it('resolves an alias', () => {
    expect(profileFor('claude-opus-5')?.inputMicroUsdPerToken).toBe(5);
  });

  it('resolves the dated id the API actually returns', () => {
    // The request names the alias; the response carries a date suffix. An exact-match
    // lookup misses here, which silently stopped cost being recorded at all.
    expect(profileFor('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
  });

  it('knows which models reject the effort parameter', () => {
    // Sending `effort` to Haiku 4.5 is a 400, not a no-op.
    expect(profileFor('claude-haiku-4-5')?.supportsEffort).toBe(false);
    expect(profileFor('claude-opus-5')?.supportsEffort).toBe(true);
  });

  it('returns null for an unknown model rather than guessing', () => {
    expect(profileFor('some-other-model')).toBeNull();
  });
});

describe('costMicroUsd', () => {
  const usage = {
    inputTokens: 1_000,
    outputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  it('prices input and output at the model rate', () => {
    expect(costMicroUsd('claude-opus-5', usage)).toBe(1_000 * 5 + 100 * 25);
  });

  it('prices cache writes at 1.25x and reads at 0.1x the input rate', () => {
    const cached = { ...usage, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 1_000 };

    expect(costMicroUsd('claude-opus-5', cached)).toBe(
      1_000 * 5 + 1_000 * 5 * 1.25 + 1_000 * 5 * 0.1 + 100 * 25,
    );
  });

  it('makes the fast tier five times cheaper than the deep tier', () => {
    expect(costMicroUsd('claude-opus-5', usage)! / costMicroUsd('claude-haiku-4-5', usage)!).toBe(
      5,
    );
  });

  it('returns null rather than a wrong number for an unknown model', () => {
    expect(costMicroUsd('some-other-model', usage)).toBeNull();
  });
});
