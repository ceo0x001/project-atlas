import { describe, expect, it } from 'vitest';
import { idFromSeed, isUlid, newId, toId } from './id';

describe('newId', () => {
  it('produces valid ULIDs', () => {
    expect(isUlid(newId())).toBe(true);
  });

  it('is unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId<'TestId'>()));

    expect(ids.size).toBe(500);
  });

  it('sorts in creation order, including within the same millisecond', () => {
    // Monotonicity matters for turn ordering and event replay, where several ids
    // are minted in the same tick.
    const ids = Array.from({ length: 50 }, () => newId<'TestId'>());

    expect([...ids].sort()).toEqual(ids);
  });
});

describe('idFromSeed', () => {
  it('is fully deterministic — the same seed always yields the same id', () => {
    // The whole point: a test may generate an id during setup and regenerate it
    // during assertion. Seeding only the timestamp half would break that.
    expect(idFromSeed<'TestId'>(1_404)).toBe(idFromSeed<'TestId'>(1_404));
    expect(idFromSeed<'TestId'>(0)).toBe(idFromSeed<'TestId'>(0));
  });

  it('gives different ids for different seeds', () => {
    const ids = new Set([1, 2, 3, 1_000, 1_404, 99_999].map((seed) => idFromSeed<'TestId'>(seed)));

    expect(ids.size).toBe(6);
  });

  it('produces valid ULIDs, including for seed zero', () => {
    for (const seed of [0, 1, 1_404, 2_147_483_647]) {
      expect(isUlid(idFromSeed<'TestId'>(seed))).toBe(true);
    }
  });
});

describe('toId', () => {
  it('accepts a well-formed ULID', () => {
    const id = newId<'TestId'>();

    expect(toId<'TestId'>(id)).toBe(id);
  });

  it.each(['', 'not-a-ulid', '0123456789012345678901234', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'])(
    'rejects %s',
    (value) => {
      expect(() => toId(value)).toThrow();
    },
  );

  it('rejects Crockford-excluded letters, which are decode ambiguities', () => {
    // I, L, O and U are excluded from the alphabet precisely to avoid confusion.
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });
});
