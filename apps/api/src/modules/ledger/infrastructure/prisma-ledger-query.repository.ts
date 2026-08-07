import { Injectable } from '@nestjs/common';
import {
  type AccountId,
  type CategoryId,
  type CurrencyCode,
  type MerchantId,
  Money,
  type TransactionId,
  type UserId,
} from '@atlas/shared-kernel';
import { TenantScope } from '@shared/prisma/tenant-scope';
import type {
  LedgerAggregateRow,
  LedgerGroupBy,
  LedgerQueryPlan,
  LedgerQueryResult,
} from '../domain/ledger-query';
import { validateQueryPlan } from '../domain/ledger-query.validator';
import type { CategoryRef, LedgerQueryPort, MerchantRef } from '../domain/ledger-query.port';
import type {
  AccountBalance,
  TransactionDirection,
  TransactionStatus,
  TransactionView,
} from '../domain/types';
import { compileAggregate, compileTransactionList } from './sql/aggregate-compiler';

/**
 * The read side of the ledger, over Postgres.
 *
 * Every query runs through `TenantScope`, so row-level security is active and the
 * process holds no credential that could bypass it. Monetary columns arrive as
 * strings (the compiler casts them to `text`) and are turned into `Money` here —
 * no value passes through a JavaScript number on the way.
 */

interface AggregateRow {
  readonly g0: string | null;
  readonly g1: string | null;
  readonly total: string;
  readonly count: string;
  readonly minAmount: string | null;
  readonly maxAmount: string | null;
  readonly evidence: string[] | null;
}

interface TransactionRow {
  readonly id: string;
  readonly accountId: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly direction: string;
  readonly occurredAt: Date;
  readonly description: string;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly balanceAfterMinor: string | null;
  readonly status: string;
}

interface AccountRow {
  readonly id: string;
  readonly label: string;
  readonly currency: string;
  readonly currentBalanceMinor: bigint | null;
  readonly balanceAsOf: Date | null;
}

@Injectable()
export class PrismaLedgerQueryRepository implements LedgerQueryPort {
  constructor(private readonly tenantScope: TenantScope) {}

  /**
   * Validates before compiling, even though callers are expected to have validated
   * already. The plan originates from a language model, and one unchecked path is
   * all it takes for a malformed plan to reach the database.
   */
  private validate(plan: LedgerQueryPlan): LedgerQueryPlan {
    const validated = validateQueryPlan(plan);

    if (!validated.ok) {
      const summary = validated.error
        .map((defect) => `${defect.code}: ${defect.detail}`)
        .join('; ');
      throw new Error(`Invalid ledger query plan — ${summary}`);
    }

    return validated.value;
  }

  async aggregate(plan: LedgerQueryPlan): Promise<LedgerQueryResult> {
    const validated = this.validate(plan);
    const { sql, params } = compileAggregate(validated);
    const currency = validated.filter.currency;

    const rows = await this.tenantScope.run(validated.userId, (tx) =>
      tx.$queryRawUnsafe<AggregateRow[]>(sql, ...params),
    );

    const groupBy = validated.groupBy ?? [];
    const provenance = new Set<string>();

    const mapped: LedgerAggregateRow[] = rows.map((row) => {
      for (const id of row.evidence ?? []) provenance.add(id);

      const total = Money.of(BigInt(row.total), currency);
      const count = Number(row.count);

      return {
        key: this.buildKey(groupBy, row),
        total,
        count,
        // Derived exactly from SUM and COUNT rather than asking Postgres for AVG,
        // so the rounding mode is ours and no float is involved (invariant I2).
        average: count > 0 ? total.multiplyByRatio(1, count, 'HALF_EVEN') : null,
        min: row.minAmount === null ? null : Money.of(BigInt(row.minAmount), currency),
        max: row.maxAmount === null ? null : Money.of(BigInt(row.maxAmount), currency),
      };
    });

    return {
      rows: mapped,
      currency,
      window: { from: validated.filter.occurredFrom, to: validated.filter.occurredTo },
      provenance: [...provenance] as TransactionId[],
      generatedAt: new Date(),
      /**
       * Always false until reconciliation lands in M2. Gap detection needs the
       * balance-discontinuity check over observations (ARCHITECTURE §5.1); claiming
       * completeness we cannot verify would be worse than admitting we do not know.
       */
      hasKnownGaps: false,
    };
  }

  private buildKey(
    groupBy: readonly LedgerGroupBy[],
    row: AggregateRow,
  ): Partial<Record<LedgerGroupBy, string>> {
    const key: Partial<Record<LedgerGroupBy, string>> = {};
    const values = [row.g0, row.g1];

    groupBy.forEach((dimension, index) => {
      const value = values[index];
      if (value !== null && value !== undefined) key[dimension] = value;
    });

    return key;
  }

  async listTransactions(plan: LedgerQueryPlan): Promise<readonly TransactionView[]> {
    const validated = this.validate(plan);
    const { sql, params } = compileTransactionList(validated);
    const currency = validated.filter.currency;

    const rows = await this.tenantScope.run(validated.userId, (tx) =>
      tx.$queryRawUnsafe<TransactionRow[]>(sql, ...params),
    );

    return rows.map((row) => ({
      id: row.id as TransactionId,
      accountId: row.accountId as AccountId,
      amount: Money.of(BigInt(row.amountMinor), currency),
      direction: row.direction as TransactionDirection,
      occurredAt: row.occurredAt,
      description: row.description,
      categoryId: row.categoryId as CategoryId | null,
      merchantId: row.merchantId as MerchantId | null,
      balanceAfter:
        row.balanceAfterMinor === null ? null : Money.of(BigInt(row.balanceAfterMinor), currency),
      status: row.status as TransactionStatus,
    }));
  }

  /**
   * Case-insensitive match on slug or name. System categories (null userId) are
   * visible alongside the user's own, per the RLS policy on `categories`.
   */
  async findCategory(userId: UserId, term: string): Promise<CategoryRef | null> {
    const normalised = term.trim().toLowerCase();
    if (normalised === '') return null;

    const rows = await this.tenantScope.run(userId, (tx) =>
      tx.category.findMany({
        where: {
          OR: [{ slug: normalised }, { name: { equals: term.trim(), mode: 'insensitive' } }],
        },
        select: { id: true, slug: true, name: true },
        take: 1,
      }),
    );

    const row = rows[0];

    return row ? { id: row.id as CategoryId, slug: row.slug, name: row.name } : null;
  }

  async findMerchant(userId: UserId, term: string): Promise<MerchantRef | null> {
    const normalised = term.trim();
    if (normalised === '') return null;

    const rows = await this.tenantScope.run(userId, (tx) =>
      tx.merchant.findMany({
        where: { displayName: { contains: normalised, mode: 'insensitive' } },
        select: { id: true, displayName: true },
        take: 1,
      }),
    );

    const row = rows[0];

    return row ? { id: row.id as MerchantId, displayName: row.displayName } : null;
  }

  async getBalances(userId: UserId): Promise<readonly AccountBalance[]> {
    const rows = await this.tenantScope.run(
      userId,
      (tx) =>
        tx.$queryRaw<AccountRow[]>`
        SELECT id, label, currency, "currentBalanceMinor", "balanceAsOf"
        FROM accounts
        WHERE "isActive" = true
        ORDER BY label ASC
      `,
    );

    return rows.map((row) => ({
      accountId: row.id as AccountId,
      label: row.label,
      currency: row.currency as CurrencyCode,
      balance: Money.of(row.currentBalanceMinor ?? 0n, row.currency as CurrencyCode),
      /**
       * Null when no source has ever corroborated this balance. The assistant must
       * be able to say how fresh a number is rather than implying it is live.
       */
      asOf: row.balanceAsOf,
    }));
  }
}
