import { Inject, Injectable } from '@nestjs/common';
import {
  type CategoryId,
  type Clock,
  CLOCK,
  type CurrencyCode,
  err,
  type MerchantId,
  Money,
  ok,
  type Result,
} from '@atlas/shared-kernel';
import {
  type LedgerGroupBy,
  LEDGER_QUERY_PORT,
  type LedgerQueryPlan,
  type LedgerQueryPort,
} from '@modules/ledger';
import { z } from 'zod';
import {
  type NamedPeriod,
  resolveExplicitRange,
  resolvePeriod,
  type ResolvedPeriod,
} from '../../domain/period';
import type {
  AtlasTool,
  GroundingFact,
  ToolContext,
  ToolDefinition,
  ToolExecutionError,
  ToolInvocationResult,
} from '../../domain/tool';

/**
 * `query_ledger` — the model's only route to a financial number.
 *
 * Three deliberate choices shape the input schema:
 *
 * 1. **The model never produces an identifier.** It names a category or merchant in
 *    words; the ledger resolves it. A ULID the model has not seen is a ULID it would
 *    have to invent.
 * 2. **The model never does date arithmetic.** It names a period; the ledger computes
 *    the boundaries in the user's timezone. Explicit dates are available but are the
 *    exception, not the norm.
 * 3. **An unresolved filter is never silently dropped.** If the user asks about a
 *    category that does not exist, the tool returns *no total at all* — because an
 *    unfiltered total presented as a category total is a confident lie, and the
 *    grounding gate cannot catch it (the number would be perfectly real).
 */

const NAMED_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'last_year',
  'last_7_days',
  'last_30_days',
] as const;

const GROUP_BY_VALUES = ['category', 'merchant', 'account', 'day', 'week', 'month'] as const;

const MAX_ROWS = 50;

/**
 * Runtime validation of the model's input.
 *
 * Duplicates the JSON Schema below, which is what the model actually sees. The two
 * are kept in step by a test that compares their property sets — worth revisiting
 * with a generator once there are several tools.
 */
const inputSchema = z.object({
  measure: z.enum(['spending', 'income']),
  period: z.enum([...NAMED_PERIODS, 'custom']),
  from: z.string().optional(),
  to: z.string().optional(),
  group_by: z.array(z.enum(GROUP_BY_VALUES)).max(2).optional(),
  category: z.string().max(100).optional(),
  merchant: z.string().max(100).optional(),
  search: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
});

export type QueryLedgerInput = z.infer<typeof inputSchema>;

export interface QueryLedgerRow {
  readonly key: string;
  readonly label: string;
  readonly total: string;
  readonly count: number;
}

export interface QueryLedgerData {
  readonly measure: 'spending' | 'income';
  readonly period: { readonly label: string; readonly from: string; readonly to: string };
  readonly currency: CurrencyCode;
  readonly total?: string;
  readonly count?: number;
  readonly rows?: readonly QueryLedgerRow[];
  /**
   * Set when a named filter could not be resolved. When present, no total is
   * returned — the assistant must report that it could not find the thing asked
   * about rather than answer a different question.
   */
  readonly unresolved?: { readonly kind: 'category' | 'merchant'; readonly term: string };
  /** Present when the ledger knows its data for this window is incomplete. */
  readonly incomplete?: true;
}

@Injectable()
export class QueryLedgerTool implements AtlasTool<unknown, QueryLedgerData> {
  readonly definition: ToolDefinition = {
    name: 'query_ledger',
    description: [
      "Query the user's own transaction ledger for spending or income totals.",
      'This is the only way to obtain a financial figure — never state an amount that did not come from this tool.',
      "Name a period (for example last_month) rather than calculating dates; the ledger resolves it in the user's timezone.",
      'Name a category or merchant in plain words; do not invent identifiers.',
      'Use group_by to break a total down, for example by month to compare periods.',
      'Use search to match text in the transaction description, for example a merchant name seen in an alert.',
    ].join(' '),
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        measure: {
          type: 'string',
          enum: ['spending', 'income'],
          description: 'Whether to total money leaving (spending) or arriving (income).',
        },
        period: {
          type: 'string',
          enum: [...NAMED_PERIODS, 'custom'],
          description:
            "The window to query. Prefer a named period. Use 'custom' only when the user gave specific dates, and then supply from and to.",
        },
        from: {
          type: 'string',
          description: "Start date as YYYY-MM-DD. Required when period is 'custom'.",
        },
        to: {
          type: 'string',
          description: "End date as YYYY-MM-DD, inclusive. Required when period is 'custom'.",
        },
        group_by: {
          type: 'array',
          items: { type: 'string', enum: [...GROUP_BY_VALUES] },
          maxItems: 2,
          description: 'Optional breakdown dimensions, at most two.',
        },
        category: { type: 'string', description: 'Restrict to a category, named in plain words.' },
        merchant: { type: 'string', description: 'Restrict to a merchant, named in plain words.' },
        search: {
          type: 'string',
          description: 'Restrict to transactions whose description contains this text.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_ROWS,
          description: 'Maximum number of grouped rows to return.',
        },
      },
      required: ['measure', 'period'],
      additionalProperties: false,
    },
  };

  constructor(
    @Inject(LEDGER_QUERY_PORT) private readonly ledger: LedgerQueryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    rawInput: unknown,
    context: ToolContext,
  ): Promise<Result<ToolInvocationResult<QueryLedgerData>, ToolExecutionError>> {
    const parsed = inputSchema.safeParse(rawInput);

    if (!parsed.success) {
      return err({
        code: 'INVALID_INPUT',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      });
    }

    const input = parsed.data;

    const window = this.resolveWindow(input, context.timeZone);
    if (!window) {
      return err({
        code: 'INVALID_INPUT',
        message:
          "period 'custom' requires valid from and to dates as YYYY-MM-DD, with from on or before to",
      });
    }

    // Resolve named filters before querying. An unresolved filter short-circuits:
    // answering a different question is worse than admitting the miss.
    const filters = await this.resolveFilters(input, context);
    if ('unresolved' in filters) {
      return ok({
        data: {
          measure: input.measure,
          period: this.describe(window),
          currency: context.currency,
          unresolved: filters.unresolved,
        },
        groundingFacts: [],
      });
    }

    const plan = this.buildPlan(input, window, filters, context);
    const result = await this.ledger.aggregate(plan);

    const groupBy = plan.groupBy ?? [];
    const rows = groupBy.length > 0 ? this.mapRows(result, groupBy) : undefined;

    const total = Money.sum(
      result.rows.map((row) => row.total),
      result.currency,
    );
    const count = result.rows.reduce((sum, row) => sum + row.count, 0);

    const data: QueryLedgerData = {
      measure: input.measure,
      period: this.describe(window),
      currency: result.currency,
      total: total.toDecimalString(),
      count,
      ...(rows ? { rows } : {}),
      ...(result.hasKnownGaps ? { incomplete: true as const } : {}),
    };

    return ok({
      data,
      groundingFacts: this.factsFor(total, count, rows),
      canvas: {
        kind: rows ? 'bar' : 'stat',
        title: `${input.measure === 'spending' ? 'Spending' : 'Income'} — ${window.label}`,
        // Rendered from these values directly, so what appears on screen never
        // passes through the model.
        payload: {
          total: total.toDecimalString(),
          currency: result.currency,
          count,
          rows: rows ?? [],
        },
      },
    });
  }

  private resolveWindow(input: QueryLedgerInput, timeZone: string): ResolvedPeriod | null {
    if (input.period !== 'custom') {
      return resolvePeriod(input.period as NamedPeriod, timeZone, this.clock.now());
    }

    if (!input.from || !input.to) return null;

    return resolveExplicitRange(input.from, input.to, timeZone);
  }

  private async resolveFilters(
    input: QueryLedgerInput,
    context: ToolContext,
  ): Promise<
    | { categoryId?: CategoryId; merchantId?: MerchantId }
    | { unresolved: { kind: 'category' | 'merchant'; term: string } }
  > {
    const resolved: { categoryId?: CategoryId; merchantId?: MerchantId } = {};

    if (input.category) {
      const category = await this.ledger.findCategory(context.userId, input.category);
      if (!category) return { unresolved: { kind: 'category', term: input.category } };
      resolved.categoryId = category.id;
    }

    if (input.merchant) {
      const merchant = await this.ledger.findMerchant(context.userId, input.merchant);
      if (!merchant) return { unresolved: { kind: 'merchant', term: input.merchant } };
      resolved.merchantId = merchant.id;
    }

    return resolved;
  }

  private buildPlan(
    input: QueryLedgerInput,
    window: ResolvedPeriod,
    filters: { categoryId?: CategoryId; merchantId?: MerchantId },
    context: ToolContext,
  ): LedgerQueryPlan {
    return {
      userId: context.userId,
      timezone: context.timeZone,
      metrics: ['total', 'count'],
      limit: input.limit ?? MAX_ROWS,
      ...(input.group_by?.length ? { groupBy: input.group_by as LedgerGroupBy[] } : {}),
      filter: {
        currency: context.currency,
        direction: input.measure === 'spending' ? 'DEBIT' : 'CREDIT',
        occurredFrom: window.from,
        occurredTo: window.to,
        ...(filters.categoryId ? { categoryIds: [filters.categoryId] } : {}),
        ...(filters.merchantId ? { merchantIds: [filters.merchantId] } : {}),
        ...(input.search ? { search: input.search } : {}),
      },
    };
  }

  private mapRows(
    result: Awaited<ReturnType<LedgerQueryPort['aggregate']>>,
    groupBy: readonly LedgerGroupBy[],
  ): readonly QueryLedgerRow[] {
    const primary = groupBy[0] as LedgerGroupBy;

    return result.rows.map((row) => {
      const key = row.key[primary] ?? 'unknown';

      return {
        key,
        // Time buckets arrive as timestamps; trim to the date, which is what a
        // reader wants to see. Identifier keys pass through for the client to label.
        label:
          primary === 'day' || primary === 'week' || primary === 'month' ? key.slice(0, 10) : key,
        total: row.total.toDecimalString(),
        count: row.count,
      };
    });
  }

  /**
   * Declares every number the assistant is allowed to repeat this turn. The
   * grounding gate checks the response against exactly this set.
   */
  private factsFor(
    total: Money,
    count: number,
    rows: readonly QueryLedgerRow[] | undefined,
  ): readonly GroundingFact[] {
    const facts: GroundingFact[] = [
      { label: 'total', value: total.toDecimalString(), kind: 'money' },
      { label: 'transaction count', value: String(count), kind: 'count' },
    ];

    for (const row of rows ?? []) {
      facts.push({ label: `total for ${row.label}`, value: row.total, kind: 'money' });
      facts.push({ label: `count for ${row.label}`, value: String(row.count), kind: 'count' });
    }

    return facts;
  }

  private describe(window: ResolvedPeriod): QueryLedgerData['period'] {
    return {
      label: window.label,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
  }
}
