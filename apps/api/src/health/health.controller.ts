import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';

/**
 * Liveness and readiness are separate on purpose.
 *
 * Liveness answers "is this process healthy enough to keep running" and must NOT
 * depend on the database — otherwise a brief Postgres blip restarts every instance
 * at once, turning a recoverable incident into an outage.
 *
 * Readiness answers "should this instance receive traffic" and does check
 * dependencies, so a degraded instance is quietly removed from rotation.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'ok'> }> {
    const databaseReachable = await this.prisma.ping();

    if (!databaseReachable) {
      throw new ServiceUnavailableException({ status: 'degraded', checks: { database: 'failed' } });
    }

    return { status: 'ok', checks: { database: 'ok' } };
  }
}
