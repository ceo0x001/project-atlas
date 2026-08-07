import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env';

const minimalEnv = {
  DATABASE_URL: 'postgresql://atlas:atlas@localhost:5432/atlas',
  REDIS_URL: 'redis://localhost:6379',
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('applies defaults so a fresh clone boots without a full .env', () => {
    const env = parseEnv({ ...minimalEnv });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('coerces numeric and boolean strings', () => {
    const env = parseEnv({ ...minimalEnv, PORT: '8080', OTEL_ENABLED: 'true' });

    expect(env.PORT).toBe(8080);
    expect(env.OTEL_ENABLED).toBe(true);
  });

  it('refuses to start without a database', () => {
    expect(() => parseEnv({ REDIS_URL: 'redis://localhost:6379' })).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range port rather than binding somewhere unexpected', () => {
    expect(() => parseEnv({ ...minimalEnv, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('allows missing secrets in development', () => {
    expect(() => parseEnv({ ...minimalEnv, NODE_ENV: 'development' })).not.toThrow();
  });

  it('demands every secret in production, naming each one', () => {
    let message = '';
    try {
      parseEnv({ ...minimalEnv, NODE_ENV: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('VOYAGE_API_KEY');
    expect(message).toContain('ENCRYPTION_ROOT_KEY');
    expect(message).toContain('JWT_SIGNING_KEY');
  });

  /**
   * Production is deliberately not bootable yet.
   *
   * The only OTP sender that exists writes live sign-in codes to the log, so a production
   * deploy would publish credentials to whatever aggregates logs. Refusing to start is the
   * intended behaviour, and this test exists to keep it intentional — someone removing the
   * check to "unblock a deploy" fails here rather than shipping the hole.
   *
   * When a real SMS sender is implemented, this test changes to assert it is accepted. That
   * edit should be a deliberate act, which is exactly why it is pinned.
   */
  it('still refuses production while only the development OTP sender exists', () => {
    let message = '';

    try {
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        VOYAGE_API_KEY: 'pa-test',
        ENCRYPTION_ROOT_KEY: 'root-key',
        JWT_SIGNING_KEY: 'jwt-key',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('OTP_SENDER');
    expect(message).toContain('must not be used in production');
  });

  it('accepts every other production requirement, so only the sender is outstanding', () => {
    let message = '';

    try {
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        VOYAGE_API_KEY: 'pa-test',
        ENCRYPTION_ROOT_KEY: 'root-key',
        JWT_SIGNING_KEY: 'jwt-key',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Proves the secret checks are satisfied: none of them appear among the complaints.
    for (const secret of [
      'ANTHROPIC_API_KEY',
      'VOYAGE_API_KEY',
      'ENCRYPTION_ROOT_KEY',
      'JWT_SIGNING_KEY',
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it('accepts a development environment with the log sender', () => {
    expect(() => parseEnv({ ...minimalEnv, OTP_SENDER: 'log' })).not.toThrow();
  });
});
