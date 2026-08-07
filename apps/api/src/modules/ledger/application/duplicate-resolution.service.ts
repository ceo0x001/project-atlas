import { Injectable } from '@nestjs/common';
import { type TransactionId, type UserId } from '@atlas/shared-kernel';
import { TenantScope } from '@shared/prisma/tenant-scope';
import { ReconciliationService } from './reconciliation.service';

/**
 * Answers the questions reconciliation could not answer on its own.
 *
 * When amount and timing agree but nothing corroborates, both transactions stay and the
 * pair is queued rather than merged (ADR-008 §4). This is where the user's answer is
 * applied — and it is the *only* place a merge is recorded as `decidedBy: USER`, which
 * matters for review: a figure that changed because someone chose it is a different fact
 * from one an algorithm chose.
 *
 * While a question is open the money stays counted twice. That is deliberate: an
 * unresolved duplicate is visible and correctable, whereas a wrong merge hides real
 * spending with no way for the user to notice.
 */

export type DuplicateResolution = 'MERGED' | 'KEPT_SEPARATE';

export interface PendingDuplicate {
  readonly id: string;
  readonly leftTransactionId: TransactionId;
  readonly rightTransactionId: TransactionId;
  readonly evidence: unknown;
  readonly createdAt: Date;
}

export type ResolveOutcome = 'resolved' | 'not-found' | 'already-resolved';

@Injectable()
export class DuplicateResolutionService {
  constructor(
    private readonly tenantScope: TenantScope,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async pending(userId: UserId): Promise<readonly PendingDuplicate[]> {
    return this.tenantScope.run(userId, async (tx) => {
      const rows = await tx.suspectedDuplicate.findMany({
        where: { resolution: null },
        orderBy: { createdAt: 'asc' },
      });

      return rows.map((row) => ({
        id: row.id,
        leftTransactionId: row.leftTransactionId as TransactionId,
        rightTransactionId: row.rightTransactionId as TransactionId,
        evidence: row.evidence,
        createdAt: row.createdAt,
      }));
    });
  }

  /**
   * Applies the user's answer.
   *
   * The whole thing runs in one transaction: recording the answer and performing the merge
   * it authorises must be atomic, or a crash between them leaves a question marked answered
   * with nothing done about it.
   */
  async resolve(
    userId: UserId,
    duplicateId: string,
    resolution: DuplicateResolution,
  ): Promise<ResolveOutcome> {
    return this.tenantScope.run(userId, async (tx) => {
      const queued = await tx.suspectedDuplicate.findUnique({ where: { id: duplicateId } });

      // RLS makes a missing row and another tenant's row indistinguishable here, which is
      // the correct behaviour: the caller learns nothing about what exists elsewhere.
      if (!queued) return 'not-found';
      if (queued.resolution !== null) return 'already-resolved';

      if (resolution === 'MERGED') {
        // The earlier-created transaction survives. Not the better-sourced one: id
        // stability matters more, because ids leak into insights and past explanations.
        const survivingId = queued.leftTransactionId as TransactionId;
        const absorbedId = queued.rightTransactionId as TransactionId;

        await this.reconciliation.merge(
          tx,
          userId,
          survivingId,
          absorbedId,
          { suspectedDuplicateId: duplicateId, originalEvidence: queued.evidence },
          'USER',
        );
      }

      await tx.suspectedDuplicate.update({
        where: { id: duplicateId },
        data: { resolution, resolvedAt: new Date() },
      });

      return 'resolved';
    });
  }
}
