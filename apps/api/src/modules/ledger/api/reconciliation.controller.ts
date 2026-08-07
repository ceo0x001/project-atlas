import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { AccountId, CurrencyCode, ObservationId, TransactionId } from '@atlas/shared-kernel';
import { type AuthenticatedRequest, DeviceAuthGuard } from '@modules/identity';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { TenantScope } from '@shared/prisma/tenant-scope';
import { DuplicateResolutionService } from '../application/duplicate-resolution.service';
import { GapDetectionService } from '../application/gap-detection.service';
import { ReconciliationService } from '../application/reconciliation.service';
import {
  type ListGapsRequest,
  listGapsSchema,
  type ResolveDuplicateRequest,
  resolveDuplicateSchema,
  type ResolveGapRequest,
  resolveGapSchema,
  type SplitObservationRequest,
  splitObservationSchema,
} from './reconciliation.dto';

/**
 * The user's side of reconciliation.
 *
 * Everything here exists because the matcher deliberately refuses to guess. When evidence
 * is only circumstantial it queues a question instead of merging, and a gap in the balance
 * chain is reported rather than filled in — so there has to be somewhere for the answers to
 * arrive (ADR-008 §4).
 *
 * Amounts are serialised as decimal strings by the global BigInt serialiser, never as
 * numbers: a kobo value large enough to lose precision in a double is entirely reachable.
 */
@Controller('v1/reconciliation')
@UseGuards(DeviceAuthGuard)
export class ReconciliationController {
  constructor(
    private readonly duplicates: DuplicateResolutionService,
    private readonly gaps: GapDetectionService,
    private readonly reconciliation: ReconciliationService,
    private readonly tenantScope: TenantScope,
  ) {}

  /** Pairs awaiting an answer. Both transactions are still counted while a pair is here. */
  @Get('duplicates')
  async pendingDuplicates(@Req() request: AuthenticatedRequest) {
    const pending = await this.duplicates.pending(request.principal.userId);

    return { duplicates: pending };
  }

  @Post('duplicates/:id/resolve')
  @HttpCode(200)
  async resolveDuplicate(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resolveDuplicateSchema)) body: ResolveDuplicateRequest,
  ) {
    const outcome = await this.duplicates.resolve(request.principal.userId, id, body.resolution);

    // A missing row and another tenant's row are indistinguishable here by design: row-level
    // security hides the difference, so the caller learns nothing about what exists
    // elsewhere.
    if (outcome === 'not-found') throw new NotFoundException('No such suspected duplicate');

    // Answering twice is reported rather than silently re-applied, because the second answer
    // may contradict the first and a merge is not freely reversible.
    if (outcome === 'already-resolved') {
      throw new UnprocessableEntityException('That duplicate has already been resolved');
    }

    return { status: outcome, resolution: body.resolution };
  }

  /**
   * Moves an observation onto a transaction of its own.
   *
   * The recovery path for a wrong merge, which is why it exists at all: without it an
   * over-merge would permanently hide money.
   */
  @Post('split')
  @HttpCode(200)
  async split(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(splitObservationSchema)) body: SplitObservationRequest,
  ) {
    const userId = request.principal.userId;

    const result = await this.tenantScope.run(userId, (tx) =>
      this.reconciliation.split(tx, userId, body.observationId as ObservationId),
    );

    if (!result.ok) {
      if (result.error === 'observation-not-found') {
        throw new NotFoundException('No such observation');
      }

      throw new UnprocessableEntityException(result.error);
    }

    return { transactionId: result.value };
  }

  /**
   * Money that moved with no transaction to explain it.
   *
   * Computed on demand rather than read from a table: a gap is arithmetic over readings the
   * ledger already holds, so a stored copy could only ever go stale — a missing transaction
   * arriving later closes the gap.
   */
  @Get('gaps')
  async openGaps(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(listGapsSchema)) query: ListGapsRequest,
  ) {
    const open = await this.gaps.openGaps(
      request.principal.userId,
      query.accountId as AccountId,
      query.currency as CurrencyCode,
    );

    return {
      gaps: open.map((gap) => ({
        amountMinor: gap.amount.minor,
        currency: gap.amount.currency,
        missingDirection: gap.missingDirection,
        afterAt: gap.afterAt,
        beforeAt: gap.beforeAt,
        afterTransactionId: gap.afterTransactionId,
        beforeTransactionId: gap.beforeTransactionId,
      })),
    };
  }

  @Post('gaps/resolve')
  @HttpCode(200)
  async resolveGap(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(resolveGapSchema)) body: ResolveGapRequest,
  ) {
    const recorded = await this.gaps.resolve(
      request.principal.userId,
      body.accountId as AccountId,
      body.currency as CurrencyCode,
      body.afterTransactionId as TransactionId,
      body.beforeTransactionId as TransactionId,
      body.resolution,
    );

    // Refusing an answer to a gap that does not exist keeps a client from accumulating
    // resolutions for arbitrary pairs — otherwise a real gap appearing between them later
    // would arrive already dismissed.
    if (!recorded) throw new NotFoundException('No such open gap');

    return { status: 'resolved', resolution: body.resolution };
  }
}
