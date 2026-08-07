import type { LedgerGroupBy, LedgerMetric, LedgerQueryPlan } from '../../domain/ledger-query';

/**
 * Compiles a validated query plan into parameterised SQL.
 *
 * This is where model-authored input meets the database, so the rules are absolute:
 *
 *   - **No value is ever interpolated.** Every value becomes a `$n` placeholder.
 *   - **Every identifier comes from an allowlist.** Group-by dimensions, metrics and
 *     sort directions map through frozen tables; an unrecognised key throws rather
 *     than reaching the string builder.
 *   - **Money never touches a float.** Aggregates are cast to `text` and parsed as
 *     BigInt. `AVG()` is deliberately unused — averages are derived with explicit
 *     rounding in the Money value object (invariant I2).
 *
 * Together these mean a malicious or malformed plan can produce a *wrong* answer at
 * worst, never an injected one — and the validator upstream exists to catch wrong.
 */

/** Evidence ids attached to each row, so a number can always be drilled into (I6). */
export const EVIDENCE_SAMPLE_SIZE = 10;

/**
 * Only settled movements count toward totals. PENDING is money that may not
 * happen and REVERSED is money that did not; including either would make Atlas
 * disagree with the user's bank statement.
 */
const SETTLED_STATUS = 'POSTED';

export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Collects bind parameters so a value can never be concatenated into SQL by accident. */
class ParameterList {
  private readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  snapshot(): readonly unknown[] {
    return [...this.values];
  }
}

/**
 * Group-by dimension to SQL expression.
 *
 * `bindTimezone` is called lazily and only by the time-bucketing dimensions, so a
 * query that groups by category never carries a dead timezone parameter.
 */
function groupExpression(dimension: LedgerGroupBy, bindTimezone: () => string): string {
  switch (dimension) {
    case 'category':
      return 't."categoryId"';
    case 'merchant':
      return 't."merchantId"';
    case 'account':
      return 't."accountId"';
    case 'direction':
      return 't.direction::text';
    case 'day':
      return `date_trunc('day', t."occurredAt" AT TIME ZONE ${bindTimezone()})::text`;
    case 'week':
      return `date_trunc('week', t."occurredAt" AT TIME ZONE ${bindTimezone()})::text`;
    case 'month':
      return `date_trunc('month', t."occurredAt" AT TIME ZONE ${bindTimezone()})::text`;
    default: {
      // Unreachable for a validated plan; defence in depth against a new dimension
      // being added to the type without a compiler branch.
      const exhaustive: never = dimension;
      throw new Error(`unsupported group-by dimension '${String(exhaustive)}'`);
    }
  }
}

/**
 * Sort metric to its *numeric* aggregate expression.
 *
 * Deliberately not the `::text` select alias: ordering '1000' against '9' as text
 * ranks nine hundred-fold larger spending below it, which would quietly invert
 * every "what did I spend most on" answer.
 */
function sortExpression(metric: LedgerMetric): string {
  switch (metric) {
    case 'total':
      return 'SUM(t."amountMinor")';
    case 'count':
      return 'COUNT(*)';
    case 'average':
      return 'SUM(t."amountMinor")::numeric / NULLIF(COUNT(*), 0)';
    case 'min':
      return 'MIN(t."amountMinor")';
    case 'max':
      return 'MAX(t."amountMinor")';
    default: {
      const exhaustive: never = metric;
      throw new Error(`unsupported sort metric '${String(exhaustive)}'`);
    }
  }
}

/** Escapes LIKE metacharacters so a search for "50%" does not match everything. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Predicates shared by the aggregate and list queries. */
function buildPredicates(plan: LedgerQueryPlan, parameters: ParameterList): string[] {
  const { filter } = plan;
  const predicates: string[] = [
    `t."userId" = ${parameters.bind(plan.userId)}`,
    `t.status = ${parameters.bind(SETTLED_STATUS)}::"TransactionStatus"`,
    `t.currency = ${parameters.bind(filter.currency)}`,
    `t."occurredAt" >= ${parameters.bind(filter.occurredFrom)}`,
    `t."occurredAt" <= ${parameters.bind(filter.occurredTo)}`,
  ];

  if (filter.accountIds?.length) {
    predicates.push(`t."accountId" = ANY(${parameters.bind([...filter.accountIds])}::text[])`);
  }
  if (filter.categoryIds?.length) {
    predicates.push(`t."categoryId" = ANY(${parameters.bind([...filter.categoryIds])}::text[])`);
  }
  if (filter.merchantIds?.length) {
    predicates.push(`t."merchantId" = ANY(${parameters.bind([...filter.merchantIds])}::text[])`);
  }
  if (filter.direction) {
    predicates.push(`t.direction = ${parameters.bind(filter.direction)}::"TransactionDirection"`);
  }
  if (filter.minAmount) {
    predicates.push(
      `t."amountMinor" >= ${parameters.bind(filter.minAmount.minor.toString())}::bigint`,
    );
  }
  if (filter.maxAmount) {
    predicates.push(
      `t."amountMinor" <= ${parameters.bind(filter.maxAmount.minor.toString())}::bigint`,
    );
  }
  if (filter.search) {
    const pattern = `%${escapeLikePattern(filter.search)}%`;
    predicates.push(`t.description ILIKE ${parameters.bind(pattern)} ESCAPE '\\'`);
  }

  return predicates;
}

/**
 * Compiles the grouped aggregation behind "how much did I spend on X, by Y".
 *
 * SUM, COUNT, MIN and MAX are always computed rather than only the requested
 * metrics: it is a single pass either way, and it means `average` can be derived
 * exactly from SUM and COUNT instead of asking Postgres for a float.
 */
export function compileAggregate(plan: LedgerQueryPlan): CompiledQuery {
  const parameters = new ParameterList();
  const groupBy = plan.groupBy ?? [];

  // Bound at most once, and only if a time dimension actually needs it.
  let timezoneParam: string | undefined;
  const bindTimezone = (): string => (timezoneParam ??= parameters.bind(plan.timezone));

  const groupSelects = groupBy.map(
    (dimension, index) => `${groupExpression(dimension, bindTimezone)} AS g${index}`,
  );

  const selects = [
    ...groupSelects,
    'COALESCE(SUM(t."amountMinor"), 0)::text AS total',
    'COUNT(*)::text AS "count"',
    'MIN(t."amountMinor")::text AS "minAmount"',
    'MAX(t."amountMinor")::text AS "maxAmount"',
    `(array_agg(t.id ORDER BY t."occurredAt" DESC))[1:${EVIDENCE_SAMPLE_SIZE}] AS evidence`,
  ];

  const predicates = buildPredicates(plan, parameters);

  const clauses = [
    `SELECT ${selects.join(', ')}`,
    'FROM transactions t',
    `WHERE ${predicates.join(' AND ')}`,
  ];

  if (groupBy.length > 0) {
    const ordinals = groupBy.map((_dimension, index) => index + 1);
    clauses.push(`GROUP BY ${ordinals.join(', ')}`);

    const sortMetric = plan.sort?.by ?? 'total';
    const direction = plan.sort?.direction === 'asc' ? 'ASC' : 'DESC';
    // Group ordinals as a tiebreaker keep pagination and snapshots stable.
    clauses.push(
      `ORDER BY ${sortExpression(sortMetric)} ${direction} NULLS LAST, ${ordinals.join(', ')}`,
    );
  }

  clauses.push(`LIMIT ${parameters.bind(plan.limit ?? 100)}`);

  return { sql: clauses.join('\n'), params: parameters.snapshot() };
}

/** Compiles the drill-down list behind "show me those transactions". */
export function compileTransactionList(plan: LedgerQueryPlan): CompiledQuery {
  const parameters = new ParameterList();
  const predicates = buildPredicates(plan, parameters);

  const sql = [
    'SELECT',
    [
      't.id',
      't."accountId"',
      't."amountMinor"::text AS "amountMinor"',
      't.currency',
      't.direction::text AS direction',
      't."occurredAt"',
      't.description',
      't."categoryId"',
      't."merchantId"',
      't."balanceAfterMinor"::text AS "balanceAfterMinor"',
      't.status::text AS status',
    ].join(', '),
    'FROM transactions t',
    `WHERE ${predicates.join(' AND ')}`,
    // id as tiebreaker: ULIDs sort by creation time, so ties resolve deterministically.
    'ORDER BY t."occurredAt" DESC, t.id DESC',
    `LIMIT ${parameters.bind(plan.limit ?? 100)}`,
  ].join('\n');

  return { sql, params: parameters.snapshot() };
}
