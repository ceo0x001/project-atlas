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
   * Production boots with phone sign-in disabled, which is the single-user posture (ADR-009).
   * `none` removes the flow rather than weakening it, so there is no code to leak.
   */
  it('accepts production with phone sign-in disabled', () => {
    expect(() =>
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        OTP_SENDER: 'none',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        VOYAGE_API_KEY: 'pa-test',
        ENCRYPTION_ROOT_KEY: 'root-key',
        JWT_SIGNING_KEY: 'jwt-key',
      }),
    ).not.toThrow();
  });

  /**
   * The development sender writes live sign-in codes to the log, so it stays forbidden in
   * production. Pinned so removing the check to "unblock a deploy" fails here rather than
   * shipping credentials into a log aggregator.
   */
  it('still refuses production with the development OTP sender', () => {
    let message = '';

    try {
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        OTP_SENDER: 'log',
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

  it('disables phone sign-in by default', () => {
    expect(parseEnv(minimalEnv).OTP_SENDER).toBe('none');
  });

  it('accepts a development environment with the log sender', () => {
    expect(() => parseEnv({ ...minimalEnv, OTP_SENDER: 'log' })).not.toThrow();
  });
});
