import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from '@atlas/shared-kernel';
import { ENV, parseEnv } from './env';

/**
 * Global providers every module may rely on: validated configuration and the
 * clock. The clock is injected rather than read from `Date` directly so that
 * time-window logic (reconciliation, schedules) is testable — see Clock in the
 * shared kernel.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => parseEnv() },
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [ENV, CLOCK],
})
export class ConfigModule {}
