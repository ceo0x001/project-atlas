import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { type AuthenticatedRequest, DeviceAuthGuard } from '@modules/identity';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { ObservationIntakeService } from '../application/observation-intake.service';
import {
  type SyncObservationsRequest,
  type SyncObservationsResponse,
  syncObservationsSchema,
} from './sync.dto';
import { MAX_OBSERVATIONS_PER_BATCH } from './sync.dto';

/**
 * Device sync.
 *
 * Identity comes exclusively from the authenticated device principal. The request
 * body has no user id and never will: accepting one would let any device write into
 * any account.
 *
 * The response reports a per-observation outcome rather than a single status code,
 * because a batch is legitimately mixed — some rows new, some already synced, some
 * refused. The device uses it to decide what to stop retrying.
 */
@Controller('v1/sync')
@UseGuards(DeviceAuthGuard)
export class SyncController {
  constructor(private readonly intake: ObservationIntakeService) {}

  /**
   * Idempotent: replaying a batch reports every row as DUPLICATE and changes
   * nothing, so a client that loses the response can safely retry rather than
   * having to reason about what got through.
   */
  @Post('observations')
  @HttpCode(200)
  async observations(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(syncObservationsSchema)) body: SyncObservationsRequest,
  ): Promise<SyncObservationsResponse> {
    return this.intake.ingest(request.principal, body.observations);
  }

  /** Lets a client discover the batch limit instead of hard-coding it. */
  @Post('capabilities')
  @HttpCode(200)
  capabilities(): { maxObservationsPerBatch: number } {
    return { maxObservationsPerBatch: MAX_OBSERVATIONS_PER_BATCH };
  }
}
