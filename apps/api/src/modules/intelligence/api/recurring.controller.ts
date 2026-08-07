import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { CurrencyCode } from '@atlas/shared-kernel';
import { type AuthenticatedRequest, DeviceAuthGuard } from '@modules/identity';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { RecurringDetectionService } from '../application/recurring-detection.service';

/**
 * Recurring money, and what it means for the next few weeks.
 *
 * Every figure here is arithmetic over the ledger — no model, no estimate. That is what makes it
 * safe to say out loud: "rent and DSTV are due before your salary, and together that is more than
 * you have" is either true of your records or it is not.
 *
 * The list is recomputed per request rather than read from a cache, because a stored pattern goes
 * stale the moment a transaction lands, and a stale figure is worse than a slow one.
 */

const projectionQuery = z.object({
  currency: z.enum(['NGN', 'USD']).default('NGN'),
  /**
   * Up to a quarter ahead. Beyond that, a projection stops being arithmetic over known obligations
   * and becomes a guess about behaviour, which is not something this endpoint should pretend to do.
   */
  days: z.coerce.number().int().min(1).max(90).default(30),
});

type ProjectionQuery = z.infer<typeof projectionQuery>;

@Controller('v1/recurring')
@UseGuards(DeviceAuthGuard)
export class RecurringController {
  constructor(private readonly recurring: RecurringDetectionService) {}

  /** Everything currently detected, most confident first. */
  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const series = await this.recurring.refresh(request.principal.userId, new Date());

    return {
      series: series.map((entry) => ({
        label: entry.label,
        kind: entry.kind,
        cadence: entry.cadence,
        direction: entry.direction,
        expectedAmountMinor: entry.expectedAmountMinor,
        currency: entry.currency,
        intervalDays: entry.intervalDays,
        occurrences: entry.occurrences,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        nextExpectedAt: entry.nextExpectedAt,
        confidence: entry.confidence,
      })),
    };
  }

  /**
   * What is due, what is coming in, and whether the balance covers the gap.
   *
   * Habits are excluded from the arithmetic. A habit is something you choose to do, not something
   * owed — counting it would overstate what is unavoidable and turn a useful warning into one that
   * cries wolf.
   */
  @Get('upcoming')
  async upcoming(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(projectionQuery)) query: ProjectionQuery,
  ) {
    const projection = await this.recurring.project(
      request.principal.userId,
      query.currency as CurrencyCode,
      query.days,
      new Date(),
    );

    return {
      currency: projection.currency,
      horizonDays: projection.horizonDays,
      balanceMinor: projection.balance.minor,
      expectedOutgoingMinor: projection.outgoing.minor,
      expectedIncomingMinor: projection.incoming.minor,
      projectedBalanceMinor: projection.projected.minor,
      short: projection.short,
      shortfallMinor: projection.short ? projection.projected.abs().minor : 0n,
      obligations: projection.obligations.map((obligation) => ({
        seriesId: obligation.seriesId,
        label: obligation.label,
        kind: obligation.kind,
        cadence: obligation.cadence,
        amountMinor: obligation.expectedAmount.minor,
        dueAt: obligation.dueAt,
        daysAway: obligation.daysAway,
        overdue: obligation.overdue,
        confidence: obligation.confidence,
      })),
    };
  }

  /**
   * Marks a series as not real.
   *
   * Recorded separately from the detection state so a later run cannot resurrect it. Being asked
   * twice about the same wrong guess is how an assistant loses trust.
   */
  @Post(':id/dismiss')
  @HttpCode(200)
  async dismiss(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const dismissed = await this.recurring.dismiss(request.principal.userId, id);

    if (!dismissed) throw new NotFoundException('No such series, or it was already dismissed');

    return { status: 'dismissed' };
  }
}
