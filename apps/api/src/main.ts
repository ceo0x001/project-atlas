// Load .env before anything reads process.env. Deliberate and explicit: relying on
// a variable happening to be exported in a developer's shell is how a service boots
// fine locally and fails on a clean machine. In production the platform supplies the
// environment and there is no file to find, which `dotenv` handles silently.
import 'dotenv/config';

// Telemetry must come next: OpenTelemetry patches modules such as http and pg as
// they load, so anything required before this line is invisible to tracing.
import './observability/telemetry';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';
import { stopTelemetry } from './observability/telemetry';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './configure-app';
import { installBigIntSerializer } from './shared/serialization/bigint';

// Money is BigInt everywhere (ADR-003); without this the first response carrying
// an amount throws at runtime.
installBigIntSerializer();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const logger = new Logger('Bootstrap');

  // Lets Nest run onModuleDestroy hooks (Prisma disconnect) on SIGTERM.
  app.enableShutdownHooks();

  const env = app.get<Env>(ENV);

  app.enableCors({ origin: env.NODE_ENV === 'production' ? false : true });

  await app.listen(env.PORT);

  logger.log(`Atlas API listening on port ${env.PORT} [${env.NODE_ENV}]`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received, shutting down`);
    await app.close();
    await stopTelemetry();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
