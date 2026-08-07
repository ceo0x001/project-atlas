import { err, isCurrencyCode, isUlid, ok, type Result } from '@atlas/shared-kernel';
import type { LedgerGroupBy, LedgerMetric, LedgerQueryPlan } from './ledger-query';

/**
 * Validation for query plans emitted by the language model.
 *
 * The model proposes; this decides. Everything here treats the plan as untrusted
 * input, because that is exactly what it is — a structure assembled by a
 * probabilistic system from a user's sentence. The compiler downstream is
 * injection-safe on its own, so these checks are not about SQL safety; they are
 * about refusing queries that are nonsensical, ruinously expensive, or subtly
 * misleading before they consume a database connection.
 */

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
/** Beyond this a query is a table scan dressed as a question. */
export const MAX_RANGE_DAYS = 3660;
export const MAX_GROUP_BY_DIMENSIONS = 2;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_ID_FILTER_ENTRIES = 200;

const VALID_GROUP_BY: ReadonlySet<string> = new Set<LedgerGroupBy>([
  'category',
  'merchant',
  'account',
  'direction',
  'day',
  'week',
  'month',
]);

const VALID_METRICS: ReadonlySet<string> = new Set<LedgerMetric>([
  'total',
  'count',
  'average',
  'min',
  'max',
]);

export interface PlanDefect {
  readonly code:
    | 'INVALID_RANGE'
    | 'RANGE_TOO_WIDE'
    | 'INVALID_LIMIT'
    | 'INVALID_METRIC'
    | 'INVALID_GROUP_BY'
    | 'INVALID_SORT'
    | 'INVALID_CURRENCY'
    | 'INVALID_TIMEZONE'
    | 'INVALID_ID'
    | 'INVALID_SEARCH'
    | 'INVALID_AMOUNT_BOUNDS';
  readonly detail: string;
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validates a plan and returns it with defaults applied.
 *
 * Returns every defect rather than the first: when the model produces a bad plan we
 * want to hand the whole list back for a single corrective retry, not trickle out
 * one problem per round trip.
 */
export function validateQueryPlan(
  plan: LedgerQueryPlan,
): Result<LedgerQueryPlan, readonly PlanDefect[]> {
  const defects: PlanDefect[] = [];
  const { filter } = plan;

  // --- time window ---
  const from = filter.occurredFrom?.getTime();
  const to = filter.occurredTo?.getTime();

  if (from === undefined || Number.isNaN(from) || to === undefined || Number.isNaN(to)) {
    defects.push({
      code: 'INVALID_RANGE',
      detail: 'occurredFrom and occurredTo must be valid dates',
    });
  } else if (from > to) {
    defects.push({ code: 'INVALID_RANGE', detail: 'occurredFrom is after occurredTo' });
  } else if (to - from > MAX_RANGE_DAYS * DAY_MS) {
    defects.push({
      code: 'RANGE_TOO_WIDE',
      detail: `range exceeds ${MAX_RANGE_DAYS} days`,
    });
  }

  // --- currency and timezone ---
  if (!isCurrencyCode(filter.currency)) {
    defects.push({ code: 'INVALID_CURRENCY', detail: `unsupported currency '${filter.currency}'` });
  }

  if (!plan.timezone || !isKnownTimezone(plan.timezone)) {
    defects.push({ code: 'INVALID_TIMEZONE', detail: `unknown timezone '${plan.timezone}'` });
  }

  // --- metrics ---
  if (plan.metrics.length === 0) {
    defects.push({ code: 'INVALID_METRIC', detail: 'a plan must request at least one metric' });
  }

  for (const metric of plan.metrics) {
    if (!VALID_METRICS.has(metric)) {
      defects.push({ code: 'INVALID_METRIC', detail: `unknown metric '${metric}'` });
    }
  }

  // --- grouping ---
  const groupBy = plan.groupBy ?? [];

  if (groupBy.length > MAX_GROUP_BY_DIMENSIONS) {
    defects.push({
      code: 'INVALID_GROUP_BY',
      detail: `at most ${MAX_GROUP_BY_DIMENSIONS} group-by dimensions are supported`,
    });
  }

  if (new Set(groupBy).size !== groupBy.length) {
    defects.push({ code: 'INVALID_GROUP_BY', detail: 'duplicate group-by dimension' });
  }

  for (const dimension of groupBy) {
    if (!VALID_GROUP_BY.has(dimension)) {
      defects.push({ code: 'INVALID_GROUP_BY', detail: `unknown group-by '${dimension}'` });
    }
  }

  // --- sort ---
  if (plan.sort) {
    if (!VALID_METRICS.has(plan.sort.by)) {
      defects.push({ code: 'INVALID_SORT', detail: `unknown sort metric '${plan.sort.by}'` });
    } else if (!plan.metrics.includes(plan.sort.by)) {
      defects.push({
        code: 'INVALID_SORT',
        detail: `cannot sort by '${plan.sort.by}', which the plan does not request`,
      });
    }

    if (plan.sort.direction !== 'asc' && plan.sort.direction !== 'desc') {
      defects.push({ code: 'INVALID_SORT', detail: `invalid sort direction` });
    }
  }

  // --- limit ---
  const limit = plan.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    defects.push({
      code: 'INVALID_LIMIT',
      detail: `limit must be an integer between 1 and ${MAX_LIMIT}`,
    });
  }

  // --- identifier filters ---
  const idFilters: readonly (readonly [string, readonly string[] | undefined])[] = [
    ['accountIds', filter.accountIds],
    ['categoryIds', filter.categoryIds],
    ['merchantIds', filter.merchantIds],
  ];

  for (const [name, ids] of idFilters) {
    if (!ids) continue;

    if (ids.length > MAX_ID_FILTER_ENTRIES) {
      defects.push({
        code: 'INVALID_ID',
        detail: `${name} has ${ids.length} entries, limit is ${MAX_ID_FILTER_ENTRIES}`,
      });
    }

    for (const id of ids) {
      if (!isUlid(id)) {
        defects.push({ code: 'INVALID_ID', detail: `${name} contains a non-ULID value` });
        break;
      }
    }
  }

  // --- search ---
  if (filter.search !== undefined && filter.search.length > MAX_SEARCH_LENGTH) {
    defects.push({
      code: 'INVALID_SEARCH',
      detail: `search term exceeds ${MAX_SEARCH_LENGTH} characters`,
    });
  }

  // --- amount bounds ---
  if (filter.minAmount && filter.maxAmount) {
    if (
      filter.minAmount.currency !== filter.currency ||
      filter.maxAmount.currency !== filter.currency
    ) {
      defects.push({
        code: 'INVALID_AMOUNT_BOUNDS',
        detail: 'amount bounds must use the same currency as the filter',
      });
    } else if (filter.minAmount.greaterThan(filter.maxAmount)) {
      defects.push({ code: 'INVALID_AMOUNT_BOUNDS', detail: 'minAmount exceeds maxAmount' });
    }
  }

  if (defects.length > 0) return err(defects);

  return ok({ ...plan, limit });
}
