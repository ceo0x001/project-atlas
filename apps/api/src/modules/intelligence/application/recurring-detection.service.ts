import { Injectable, Logger } from '@nestjs/common';
import {
  type CategoryId,
  type CurrencyCode,
  isCurrencyCode,
  type MerchantId,
  Money,
  newId,
  type TransactionId,
  type UserId,
} from '@atlas/shared-kernel';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import {
  detectRecurringSeries,
  type RecurringCandidate,
  type RecurringInput,
} from '../domain/recurring/detect-recurring';

/**
 * Detects recurring money and keeps the stored series in step with it.
 *
 * ## Why the table is refreshed rather than accumulated
 *
 * Everything a series reports — its amount, cadence, confidence, next date — is derived from the
 * transaction history, so it goes stale the moment a transaction arrives. Storing it once and
 * trusting it later would produce exactly the failure this whole product avoids: a figure that was
 * true in June still being quoted confidently in December.
 *
 * So detection re-runs over the whole history and overwrites the derived fields every time. The row
 * exists only to give a series a stable identity that other things can point at, and to hold the
 * one thing detection must never overwrite: **the user's decision**. A dismissal is kept in its own
 * column for that reason — if it shared `isActive` with detection, the next run would resurrect
 * something the user had already rejected.
 *
 * ## The model is not involved
 *
 * A rhythm in a list of dates is arithmetic. Nothing here consults a language model, which is what
 * makes the result repeatable and checkable by hand — and means a bill can be trusted in a way an
 * inference never could.
 */

/** A year of history is enough to see an annual pattern and cheap enough to scan on demand. */
const HISTORY_DAYS = 400;

/**
 * How far back an obligation still counts as *overdue* rather than *stopped*.
 *
 * A bill whose expected date has passed is the single most useful thing this can report — "your
 * DSTV usually lands on the 3rd and I have not seen it" is exactly what a person wants to know. But
 * `nextExpectedAt` is derived from the last sighting, so a cancelled subscription would sit in the
 * past forever and be reported as overdue indefinitely.
 *
 * One full cycle is the honest boundary: later than its own interval means it probably ended rather
 * than being late. Capped at 35 days regardless, because nobody needs to hear that an annual
 * premium is two hundred days late.
 */
const MAX_OVERDUE_DAYS = 35;

export interface UpcomingObligation {
  readonly seriesId: string;
  readonly label: string;
  readonly kind: 'BILL' | 'INCOME' | 'HABIT';
  readonly cadence: string;
  readonly expectedAmount: Money;
  readonly dueAt: Date;
  /** Negative when the date has already passed. */
  readonly daysAway: number;
  /** Expected and not seen. Worth saying before anything that is merely upcoming. */
  readonly overdue: boolean;
  readonly confidence: number;
}

export interface ShortfallProjection {
  readonly currency: CurrencyCode;
  readonly balance: Money;
  readonly outgoing: Money;
  readonly incoming: Money;
  /**
   * Balance plus expected income minus expected outgoings, including anything overdue. Negative
   * means short — an unpaid bill still has to be paid, so leaving it out would flatter the figure.
   */
  readonly projected: Money;
  readonly short: boolean;
  readonly horizonDays: number;
  readonly obligations: readonly UpcomingObligation[];
}

@Injectable()
export class RecurringDetectionService {
  private readonly logger = new Logger(RecurringDetectionService.name);

  constructor(private readonly tenantScope: TenantScope) {}

  /**
   * Re-detects every series for a user and reconciles the stored rows with what was found.
   *
   * Returns what is currently believed, so a caller can detect and read in one step.
   */
  async refresh(userId: UserId, now: Date): Promise<readonly RecurringCandidate[]> {
    return this.tenantScope.run(userId, async (tx) => {
      const history = await this.loadHistory(tx, now);
      const candidates = detectRecurringSeries(history);

      const dismissed = await this.dismissedKeys(tx);
      const kept = candidates.filter((candidate) => !dismissed.has(candidate.key));

      await this.persist(tx, userId, kept);

      // Series the detection no longer sees are deactivated rather than deleted: a bill that
      // stopped is a fact worth keeping, and deleting the row would also drop the user's label.
      await tx.recurringSeries.updateMany({
        where: { detectionKey: { notIn: kept.map((candidate) => candidate.key) }, isActive: true },
        data: { isActive: false },
      });

      this.logger.debug(`Detected ${kept.length} recurring series for ${userId}`);

      return kept;
    });
  }

  /**
   * What is expected in the next `horizonDays`, and whether the balance covers it.
   *
   * This is the question worth answering. "DSTV is due Thursday" is mildly useful; "rent and DSTV
   * both land before your salary and that is ₦40,000 more than you have" is something a person can
   * act on — and it is arrived at by adding known figures, with no estimation anywhere.
   */
  async project(
    userId: UserId,
    currency: CurrencyCode,
    horizonDays: number,
    now: Date,
  ): Promise<ShortfallProjection> {
    await this.refresh(userId, now);

    return this.tenantScope.run(userId, async (tx) => {
      const until = new Date(now.getTime() + horizonDays * 86_400_000);
      // Reaches into the past so an unpaid bill is not silently dropped. Filtering only on
      // `>= now` hid a payment that was four days late and reported "not short" while ignoring it.
      const from = new Date(now.getTime() - MAX_OVERDUE_DAYS * 86_400_000);

      const rows = await tx.recurringSeries.findMany({
        where: {
          currency,
          isActive: true,
          dismissedAt: null,
          nextExpectedAt: { gte: from, lte: until },
          // Habits are excluded on purpose. A habit is something you choose to do, not something
          // owed, so counting it as a commitment would overstate what is unavoidable.
          kind: { in: ['BILL', 'INCOME'] },
        },
        orderBy: { nextExpectedAt: 'asc' },
      });

      const accounts = await tx.account.findMany({
        where: { currency, isActive: true },
        select: { currentBalanceMinor: true },
      });

      const balance = Money.sum(
        accounts.map((account) => Money.of(account.currentBalanceMinor ?? 0n, currency)),
        currency,
      );

      const obligations: UpcomingObligation[] = rows.flatMap((row) => {
        if (row.nextExpectedAt === null) return [];

        const daysAway = Math.ceil((row.nextExpectedAt.getTime() - now.getTime()) / 86_400_000);

        // Later than its own cycle means it probably stopped rather than being late. Dropping it
        // here keeps a cancelled subscription from being reported as overdue for ever.
        const tolerance = Math.min(row.intervalDays ?? MAX_OVERDUE_DAYS, MAX_OVERDUE_DAYS);
        if (daysAway < -tolerance) return [];

        return [
          {
            seriesId: row.id,
            label: row.label,
            kind: row.kind,
            cadence: row.cadence,
            expectedAmount: Money.of(row.expectedAmountMinor, currency),
            dueAt: row.nextExpectedAt,
            daysAway,
            overdue: daysAway < 0,
            confidence: row.confidence,
          },
        ];
      });

      const outgoing = Money.sum(
        obligations.filter((o) => o.kind === 'BILL').map((o) => o.expectedAmount),
        currency,
      );
      const incoming = Money.sum(
        obligations.filter((o) => o.kind === 'INCOME').map((o) => o.expectedAmount),
        currency,
      );

      const projected = balance.plus(incoming).minus(outgoing);

      return {
        currency,
        balance,
        outgoing,
        incoming,
        projected,
        short: projected.isNegative,
        horizonDays,
        obligations,
      };
    });
  }

  /** Records that the user does not consider this a real series. Never resurrected by detection. */
  async dismiss(userId: UserId, seriesId: string): Promise<boolean> {
    return this.tenantScope.run(userId, async (tx) => {
      const updated = await tx.recurringSeries.updateMany({
        where: { id: seriesId, dismissedAt: null },
        data: { dismissedAt: new Date(), isActive: false },
      });

      return updated.count > 0;
    });
  }

  private async loadHistory(tx: TenantClient, now: Date): Promise<readonly RecurringInput[]> {
    const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);

    const rows = await tx.transaction.findMany({
      where: {
        occurredAt: { gte: since },
        status: 'POSTED',
        // A superseded transaction's money is already represented by its survivor. Counting both
        // would turn one monthly bill into a pair of them.
        supersededByTransactionId: null,
      },
      select: {
        id: true,
        occurredAt: true,
        amountMinor: true,
        currency: true,
        direction: true,
        description: true,
        merchantId: true,
        categoryId: true,
      },
    });

    return rows.flatMap((row) => {
      if (!isCurrencyCode(row.currency)) return [];

      return [
        {
          transactionId: row.id as TransactionId,
          occurredAt: row.occurredAt,
          amountMinor: row.amountMinor,
          currency: row.currency,
          direction: row.direction,
          description: row.description,
          merchantId: row.merchantId as MerchantId | null,
          categoryId: row.categoryId as CategoryId | null,
        },
      ];
    });
  }

  private async dismissedKeys(tx: TenantClient): Promise<ReadonlySet<string>> {
    const rows = await tx.recurringSeries.findMany({
      where: { dismissedAt: { not: null } },
      select: { detectionKey: true },
    });

    return new Set(rows.map((row) => row.detectionKey));
  }

  /**
   * Writes each candidate, keyed on its detection key.
   *
   * Upserted rather than inserted so a re-run updates the derived fields in place. The `update`
   * branch deliberately omits `label`: once a user renames a series, detection must not overwrite
   * their name with the latest bank narration.
   */
  private async persist(
    tx: TenantClient,
    userId: UserId,
    candidates: readonly RecurringCandidate[],
  ): Promise<void> {
    for (const candidate of candidates) {
      const derived = {
        kind: candidate.kind,
        direction: candidate.direction,
        cadence: candidate.cadence,
        intervalDays: candidate.intervalDays,
        expectedAmountMinor: candidate.expectedAmountMinor,
        currency: candidate.currency,
        lastSeenAt: candidate.lastSeenAt,
        nextExpectedAt: candidate.nextExpectedAt,
        confidence: candidate.confidence,
        occurrences: candidate.occurrences,
        isActive: true,
        ...(candidate.merchantId === null ? {} : { merchantId: candidate.merchantId }),
        ...(candidate.categoryId === null ? {} : { categoryId: candidate.categoryId }),
      };

      await tx.recurringSeries.upsert({
        where: { userId_detectionKey: { userId, detectionKey: candidate.key } },
        update: derived,
        create: {
          id: newId<'InsightId'>(),
          userId,
          detectionKey: candidate.key,
          label: candidate.label,
          ...derived,
        },
      });
    }
  }
}
