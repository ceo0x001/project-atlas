import { z } from 'zod';

/**
 * Environment configuration, validated once at boot.
 *
 * The process refuses to start on invalid config rather than failing later on the
 * first request that happens to need a missing key. Secrets are optional in
 * development so a fresh clone runs without credentials, and mandatory in
 * production, where a missing key is a deployment defect.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);

const baseSchema = z.object({
  NODE_ENV: nodeEnv.default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Application connection — the `atlas_app` role, subject to row-level security. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Owner connection, used only by the Prisma CLI for migrations. Optional here
   * because the running service must never need it — if this process ever reads it,
   * something is reaching for privileges it should not have.
   */
  DATABASE_MIGRATION_URL: z.string().optional(),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('atlas-core'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_CONVERSATION: z.string().default('claude-opus-5'),
  ANTHROPIC_MODEL_BACKGROUND: z.string().default('claude-haiku-4-5'),
  /**
   * Reasoning effort for conversation turns. Kept in configuration rather than in
   * code because it is the primary latency/cost lever and wants sweeping against
   * real questions, not a value baked into a build.
   */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),

  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('voyage-3'),
  /** Must match the vector(N) column width in schema.prisma. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  ENCRYPTION_ROOT_KEY: z.string().optional(),
  JWT_SIGNING_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OTEL_SERVICE_NAME: z.string().default('atlas-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
});

/** Secrets that may be absent locally but must exist in a deployed environment. */
const PRODUCTION_REQUIRED = [
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'ENCRYPTION_ROOT_KEY',
  'JWT_SIGNING_KEY',
] as const;

const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  for (const key of PRODUCTION_REQUIRED) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when NODE_ENV=production`,
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return result.data;
}

export const ENV = Symbol.for('atlas.Env');
