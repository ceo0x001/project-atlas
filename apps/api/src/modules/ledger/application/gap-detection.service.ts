import { Injectable } from '@nestjs/common';
import {
  type AccountId,
  type CurrencyCode,
  newId,
  type TransactionId,
  type UserId,
} from '@atlas/shared-kernel';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import {
  type BalanceReading,
  detectGaps,
  type SuspectedGap,
} from '../domain/reconciliation/balance-chain';

/**
 * Finds money that moved without a transaction to explain it.
 *
 * ## Gaps are derived, not stored
 *
 * A gap is arithmetic over balance readings the ledger already holds, so it is computed on
 * demand rather than written by a job. That is the reason M2 needs no Temporal (ADR-008),
 * and it has a design consequence worth stating plainly: **the `suspected_gaps` table
 * stores the user's decisions, not the gaps.**
 *
 * Persisting the gaps themselves would create a cache that can only ever go stale — a
 * missing transaction arriving later closes a gap, and a stored row would keep asserting
 * it. Storing decisions instead means a dismissed gap stays dismissed while everything
 * else stays live and correct.
 *
 * ## What this never does
 *
 * It never creates the missing transaction. The discrepancy yields an amount and a time
 * range and nothing else — no merchant, no description, no direction that can be trusted
 * beyond its sign — so materialising one would put a figure in the ledger that no source
 * ever reported. A gap is a question to ask, and it stays one.
 */

@Injectable()
export class GapDetectionService {
  constructor(private readonly tenantScope: TenantScope) {}

  /**
   * Gaps in one account that the user has not already dealt with.
   *
   * Scoped to a single account and currency because balance arithmetic across either is
   * meaningless — a reading from one account says nothing about another.
   */
  async openGaps(
    userId: UserId,
    accountId: AccountId,
    currency: CurrencyCode,
  ): Promise<readonly SuspectedGap[]> {
    return this.tenantScope.run(userId, async (tx) => {
      const gaps = await this.computeGaps(tx, userId, accountId, currency);
      const resolved = await this.resolvedKeys(tx, userId, accountId);

      return gaps.filter((gap) => !resolved.has(this.keyOf(gap)));
    });
  }

  /**
   * Records the user's answer to a gap.
   *
   * Upserted on the gap's identity — the account plus the two transactions bracketing it —
   * so answering twice is idempotent and the same question is never re-asked.
   */
  async resolve(
    userId: UserId,
    accountId: AccountId,
    currency: CurrencyCode,
    afterTransactionId: TransactionId,
    beforeTransactionId: TransactionId,
    resolution: 'EXPLAINED' | 'DISMISSED',
  ): Promise<boolean> {
    return this.tenantScope.run(userId, async (tx) => {
      const gaps = await this.computeGaps(tx, userId, accountId, currency);

      const match = gaps.find(
        (gap) =>
          gap.afterTransactionId === afterTransactionId &&
          gap.beforeTransactionId === beforeTransactionId,
      );

      // Refuse to record a decision about a gap that does not exist. Otherwise a client
      // could accumulate resolutions for arbitrary transaction pairs, and a real gap
      // appearing between them later would arrive pre-dismissed.
      if (!match) return false;

      await tx.suspectedGap.upsert({
        where: {
          userId_accountId_afterTransactionId_beforeTransactionId: {
            userId,
            accountId,
            afterTransactionId,
            beforeTransactionId,
          },
        },
        update: { resolution, resolvedAt: new Date() },
        create: {
          id: newId<'InsightId'>(),
          userId,
          accountId,
          currency,
          amountMinor: match.amount.minor,
          missingDirection: match.missingDirection,
          afterTransactionId,
          beforeTransactionId,
          afterAt: match.afterAt,
          beforeAt: match.beforeAt,
          resolution,
          resolvedAt: new Date(),
        },
      });

      return true;
    });
  }

  private async computeGaps(
    tx: TenantClient,
    userId: UserId,
    accountId: AccountId,
    currency: CurrencyCode,
  ): Promise<readonly SuspectedGap[]> {
    const rows = await tx.transaction.findMany({
      where: {
        userId,
        accountId,
        currency,
        status: 'POSTED',
        // A superseded row's money is already represented by its survivor. Counting it
        // would break the chain arithmetic and manufacture a gap out of a resolved merge.
        supersededByTransactionId: null,
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        id: true,
        occurredAt: true,
        amountMinor: true,
        direction: true,
        balanceAfterMinor: true,
      },
    });

    const readings: BalanceReading[] = rows.map((row) => ({
      transactionId: row.id as TransactionId,
      occurredAt: row.occurredAt,
      amountMinor: row.amountMinor,
      direction: row.direction,
      balanceAfterMinor: row.balanceAfterMinor,
    }));

    return detectGaps(readings, currency);
  }

  private async resolvedKeys(
    tx: TenantClient,
    userId: UserId,
    accountId: AccountId,
  ): Promise<ReadonlySet<string>> {
    const rows = await tx.suspectedGap.findMany({
      where: { userId, accountId, resolution: { not: null } },
      select: { afterTransactionId: true, beforeTransactionId: true },
    });

    return new Set(rows.map((row) => `${row.afterTransactionId}|${row.beforeTransactionId}`));
  }

  private keyOf(gap: SuspectedGap): string {
    return `${gap.afterTransactionId}|${gap.beforeTransactionId}`;
  }
}
