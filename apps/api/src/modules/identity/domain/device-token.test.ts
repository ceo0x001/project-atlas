import { describe, expect, it } from 'vitest';
import { bearerTokenFrom, hashDeviceToken, issueDeviceToken } from './device-token';

describe('issueDeviceToken', () => {
  it('produces a URL-safe token with no padding', () => {
    const { token } = issueDeviceToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('=');
  });

  it('carries 256 bits of entropy', () => {
    // base64url of 32 bytes is 43 characters.
    expect(issueDeviceToken().token).toHaveLength(43);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => issueDeviceToken().token));

    expect(tokens.size).toBe(500);
  });

  it('returns a hash that matches the token', () => {
    const { token, tokenHash } = issueDeviceToken();

    expect(tokenHash).toBe(hashDeviceToken(token));
  });
});

describe('hashDeviceToken', () => {
  it('is deterministic', () => {
    expect(hashDeviceToken('abc')).toBe(hashDeviceToken('abc'));
  });

  it('produces a 64-character hex digest', () => {
    expect(hashDeviceToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not leak the token', () => {
    const secret = 'super-secret-device-token';

    expect(hashDeviceToken(secret)).not.toContain(secret);
  });
});

describe('bearerTokenFrom', () => {
  it('extracts a bearer token', () => {
    expect(bearerTokenFrom('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(bearerTokenFrom('bearer abc123')).toBe('abc123');
  });

  it('tolerates surrounding whitespace', () => {
    expect(bearerTokenFrom('  Bearer   abc123  ')).toBe('abc123');
  });

  it.each<[string | undefined, string]>([
    [undefined, 'absent header'],
    ['', 'empty header'],
    ['abc123', 'no scheme'],
    ['Basic abc123', 'wrong scheme'],
    ['Bearer', 'no token'],
    ['Bearer a b', 'token containing a space'],
  ])('rejects %s (%s)', (header, _description) => {
    expect(bearerTokenFrom(header)).toBeNull();
  });
});
