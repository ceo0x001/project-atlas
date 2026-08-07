import { describe, expect, it } from 'vitest';
import {
  type ChallengeState,
  generateOtpCode,
  hashOtpCode,
  isSupportedPhone,
  MAX_OTP_ATTEMPTS,
  normalisePhone,
  otpExpiresAt,
  OTP_TTL_MS,
  verifyOtp,
} from './otp';

const NOW = new Date('2026-08-07T10:00:00.000Z');

function challenge(overrides: Partial<ChallengeState> = {}): ChallengeState {
  return {
    codeHash: hashOtpCode('123456'),
    attempts: 0,
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + OTP_TTL_MS),
    ...overrides,
  };
}

describe('generateOtpCode', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  /** Padding rather than range-shifting, so a code beginning with zeros is reachable. */
  it('can produce codes with leading zeros', () => {
    const codes = Array.from({ length: 5_000 }, generateOtpCode);

    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself in a short run', () => {
    const codes = new Set(Array.from({ length: 200 }, generateOtpCode));

    // A predictable generator would collide far more than chance allows.
    expect(codes.size).toBeGreaterThan(180);
  });
});

describe('verifyOtp', () => {
  it('accepts the right code', () => {
    expect(verifyOtp(challenge(), '123456', NOW)).toBe('ok');
  });

  it('rejects the wrong code', () => {
    expect(verifyOtp(challenge(), '654321', NOW)).toBe('wrong-code');
  });

  it('rejects a challenge that was already used', () => {
    expect(verifyOtp(challenge({ consumedAt: NOW }), '123456', NOW)).toBe('already-used');
  });

  it('rejects once the attempt cap is reached', () => {
    expect(verifyOtp(challenge({ attempts: MAX_OTP_ATTEMPTS }), '123456', NOW)).toBe(
      'too-many-attempts',
    );
  });

  it('rejects an expired challenge', () => {
    const expired = challenge({ expiresAt: new Date(NOW.getTime() - 1) });

    expect(verifyOtp(expired, '123456', NOW)).toBe('expired');
  });

  it('treats the expiry instant as expired rather than valid', () => {
    const atBoundary = challenge({ expiresAt: NOW });

    expect(verifyOtp(atBoundary, '123456', NOW)).toBe('expired');
  });

  /**
   * State is checked before the code is compared, so a dead challenge cannot be used as a
   * free oracle: an attacker who has burned their attempts learns nothing about whether a
   * guess was right.
   */
  it('reports the state failure, not the code result, when both apply', () => {
    const dead = challenge({ attempts: MAX_OTP_ATTEMPTS });

    expect(verifyOtp(dead, '123456', NOW)).toBe('too-many-attempts');
    expect(verifyOtp(dead, '000000', NOW)).toBe('too-many-attempts');
  });

  it('reports use before exhaustion when a challenge is both', () => {
    const used = challenge({ consumedAt: NOW, attempts: MAX_OTP_ATTEMPTS });

    expect(verifyOtp(used, '123456', NOW)).toBe('already-used');
  });
});

describe('otpExpiresAt', () => {
  it('is ten minutes from the supplied clock', () => {
    expect(otpExpiresAt(NOW)).toEqual(new Date('2026-08-07T10:10:00.000Z'));
  });
});

describe('normalisePhone', () => {
  /**
   * The same person types their number several ways. Storing them as different identities
   * would split one user's ledger across several accounts.
   */
  it.each([
    ['08012345678', '+2348012345678'],
    ['+2348012345678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['8012345678', '+2348012345678'],
    ['+234 801 234 5678', '+2348012345678'],
    ['0801-234-5678', '+2348012345678'],
    ['(0801) 234 5678', '+2348012345678'],
  ])('normalises %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it.each([
    ['too short', '0801234'],
    ['too long', '080123456789'],
    ['a landline range', '08112345678a'],
    ['not Nigerian', '+14155552671'],
    ['letters', 'not-a-number'],
    ['empty', ''],
    ['a 6-prefixed mobile that does not exist', '06012345678'],
  ])('refuses %s rather than guessing', (_label, input) => {
    expect(normalisePhone(input)).toBeNull();
  });

  /** Accepting an undeliverable number would lock that account out permanently. */
  it('accepts only the 7, 8 and 9 mobile prefixes', () => {
    expect(isSupportedPhone('+2347012345678')).toBe(true);
    expect(isSupportedPhone('+2348012345678')).toBe(true);
    expect(isSupportedPhone('+2349012345678')).toBe(true);
    expect(isSupportedPhone('+2341012345678')).toBe(false);
  });
});
