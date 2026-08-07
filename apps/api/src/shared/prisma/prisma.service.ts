import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ENV, type Env } from '@config/env';

/**
 * The single database client for the process.
 *
 * Every module shares this instance; connection pooling is Prisma's job. Queries
 * are always scoped by userId in application code, with Postgres row-level
 * security as defence in depth (ARCHITECTURE §10) — belt and braces, because a
 * cross-tenant leak in a finance product is unrecoverable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({
      datasources: { db: { url: env.DATABASE_URL } },
      log:
        env.NODE_ENV === 'development'
          ? [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (error) {
      /**
       * Start anyway and report not-ready rather than crashing.
       *
       * A process that exits when the database is briefly unreachable enters
       * crash-loop backoff, which turns a recoverable Postgres blip into a full
       * outage — every instance dies at once and none come back until the
       * database does. Staying up and failing readiness lets the platform route
       * around this instance and lets Prisma reconnect on the next query.
       */
      this.logger.error(
        'Database unreachable at startup; serving traffic is disabled until it recovers',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database ping failed', error instanceof Error ? error.stack : error);
      return false;
    }
  }
}
