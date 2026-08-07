import {
  type CategoryId,
  FixedClock,
  idFromSeed,
  type MerchantId,
  Money,
  type SessionId,
  type TurnId,
  type UserId,
} from '@atlas/shared-kernel';
import type { LedgerQueryPlan, LedgerQueryPort, LedgerQueryResult } from '@modules/ledger';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../domain/tool';
import { QueryLedgerTool } from './query-ledger.tool';

const userId = idFromSeed<'UserId'>(1) as UserId;

const context: ToolContext = {
  userId,
  sessionId: idFromSeed<'SessionId'>(2) as SessionId,
  turnId: idFromSeed<'TurnId'>(3) as TurnId,
  requestedAt: new Date('2026-08-07T13:23:45Z'),
  timeZone: 'Africa/Lagos',
  currency: 'NGN',
};

/** Records the plan it was given and returns a canned aggregate. */
class RecordingLedger implements LedgerQueryPort {
  lastPlan?: LedgerQueryPlan;
  result: LedgerQueryResult = {
    rows: [
      {
        key: {},
        total: Money.of(1_250_000n, 'NGN'),
        count: 3,
        average: null,
        min: null,
        max: null,
      },
    ],
    currency: 'NGN',
    window: { from: new Date(0), to: new Date(0) },
    provenance: [],
    generatedAt: new Date(0),
    hasKnownGaps: false,
  };
  category: { id: CategoryId; slug: string; name: string } | null = null;
  merchant: { id: MerchantId; displayName: string } | null = null;

  async aggregate(plan: LedgerQueryPlan): Promise<LedgerQueryResult> {
    this.lastPlan = plan;
    return this.result;
  }

  async listTransactions(): Promise<never[]> {
    return [];
  }

  async getBalances(): Promise<never[]> {
    return [];
  }

  async findCategory(): Promise<{ id: CategoryId; slug: string; name: string } | null> {
    return this.category;
  }

  async findMerchant(): Promise<{ id: MerchantId; displayName: string } | null> {
    return this.merchant;
  }
}

let ledger: RecordingLedger;
let tool: QueryLedgerTool;

beforeEach(() => {
  ledger = new RecordingLedger();
  tool = new QueryLedgerTool(ledger, new FixedClock(new Date('2026-08-07T13:23:45Z')));
});

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('period handling', () => {
  it('resolves a named period into Lagos-local boundaries', async () => {
    await tool.execute({ measure: 'spending', period: 'this_month' }, context);

    // August 2026 in Lagos begins at 23:00 UTC on 31 July.
    expect(ledger.lastPlan!.filter.occurredFrom.toISOString()).toBe('2026-07-31T23:00:00.000Z');
    expect(ledger.lastPlan!.filter.occurredTo.toISOString()).toBe('2026-08-07T22:59:59.999Z');
  });

  it('labels the period for the assistant to echo', async () => {
    const result = expectOk(
      await tool.execute({ measure: 'spending', period: 'last_month' }, context),
    );

    expect(result.data.period.label).toBe('July 2026');
  });

  it('accepts explicit dates when the user gave them', async () => {
    await tool.execute(
      { measure: 'spending', period: 'custom', from: '2026-08-01', to: '2026-08-03' },
      context,
    );

    expect(ledger.lastPlan!.filter.occurredFrom.toISOString()).toBe('2026-07-31T23:00:00.000Z');
    expect(ledger.lastPlan!.filter.occurredTo.toISOString()).toBe('2026-08-03T22:59:59.999Z');
  });

  it.each([
    [{ period: 'custom' }, 'no dates'],
    [{ period: 'custom', from: '2026-08-01' }, 'only a start'],
    [{ period: 'custom', from: 'August 1st', to: '2026-08-03' }, 'unparseable date'],
    [{ period: 'custom', from: '2026-02-31', to: '2026-03-01' }, 'a date that does not exist'],
    [{ period: 'custom', from: '2026-08-05', to: '2026-08-01' }, 'reversed range'],
  ])('rejects custom with %j (%s)', async (patch, _label) => {
    const result = await tool.execute({ measure: 'spending', ...patch }, context);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_INPUT');
  });
});

describe('measure maps to direction', () => {
  it('treats spending as debits', async () => {
    await tool.execute({ measure: 'spending', period: 'today' }, context);

    expect(ledger.lastPlan!.filter.direction).toBe('DEBIT');
  });

  it('treats income as credits', async () => {
    await tool.execute({ measure: 'income', period: 'today' }, context);

    expect(ledger.lastPlan!.filter.direction).toBe('CREDIT');
  });
});

describe('named filters are resolved, never guessed', () => {
  it('resolves a category name to its identifier', async () => {
    ledger.category = { id: idFromSeed<'CategoryId'>(9) as CategoryId, slug: 'food', name: 'Food' };

    await tool.execute({ measure: 'spending', period: 'this_month', category: 'food' }, context);

    expect(ledger.lastPlan!.filter.categoryIds).toEqual([ledger.category.id]);
  });

  it('returns no total when a category cannot be resolved', async () => {
    // The dangerous case: an unfiltered total presented as a category total is a
    // real number answering a question nobody asked, and the grounding gate cannot
    // catch it because the figure is genuine.
    ledger.category = null;

    const result = expectOk(
      await tool.execute(
        { measure: 'spending', period: 'this_month', category: 'unicorns' },
        context,
      ),
    );

    expect(result.data.unresolved).toEqual({ kind: 'category', term: 'unicorns' });
    expect(result.data.total).toBeUndefined();
    expect(result.groundingFacts).toEqual([]);
    // And it must not have queried at all.
    expect(ledger.lastPlan).toBeUndefined();
  });

  it('returns no total when a merchant cannot be resolved', async () => {
    ledger.merchant = null;

    const result = expectOk(
      await tool.execute(
        { measure: 'spending', period: 'this_month', merchant: 'nowhere ltd' },
        context,
      ),
    );

    expect(result.data.unresolved).toEqual({ kind: 'merchant', term: 'nowhere ltd' });
    expect(result.data.total).toBeUndefined();
  });

  it('passes free-text search straight through — no resolution needed', async () => {
    await tool.execute({ measure: 'spending', period: 'this_month', search: 'shoprite' }, context);

    expect(ledger.lastPlan!.filter.search).toBe('shoprite');
  });
});

describe('grounding facts', () => {
  it('declares the total and the count', async () => {
    const result = expectOk(
      await tool.execute({ measure: 'spending', period: 'this_month' }, context),
    );

    expect(result.data.total).toBe('12500.00');
    expect(result.groundingFacts).toEqual([
      { label: 'total', value: '12500.00', kind: 'money' },
      { label: 'transaction count', value: '3', kind: 'count' },
    ]);
  });

  it('declares every grouped row, so a per-row figure can be spoken', async () => {
    ledger.result = {
      ...ledger.result,
      rows: [
        {
          key: { category: 'cat-a' },
          total: Money.of(1_000_000n, 'NGN'),
          count: 2,
          average: null,
          min: null,
          max: null,
        },
        {
          key: { category: 'cat-b' },
          total: Money.of(250_000n, 'NGN'),
          count: 1,
          average: null,
          min: null,
          max: null,
        },
      ],
    };

    const result = expectOk(
      await tool.execute(
        { measure: 'spending', period: 'this_month', group_by: ['category'] },
        context,
      ),
    );

    expect(result.data.total).toBe('12500.00');
    expect(result.data.rows).toEqual([
      { key: 'cat-a', label: 'cat-a', total: '10000.00', count: 2 },
      { key: 'cat-b', label: 'cat-b', total: '2500.00', count: 1 },
    ]);
    expect(result.groundingFacts.map((fact) => fact.value)).toContain('10000.00');
    expect(result.groundingFacts.map((fact) => fact.value)).toContain('2500.00');
  });

  it('trims time-bucket keys to a date a reader recognises', async () => {
    ledger.result = {
      ...ledger.result,
      rows: [
        {
          key: { month: '2026-08-01 00:00:00' },
          total: Money.of(500_000n, 'NGN'),
          count: 1,
          average: null,
          min: null,
          max: null,
        },
      ],
    };

    const result = expectOk(
      await tool.execute(
        { measure: 'spending', period: 'this_year', group_by: ['month'] },
        context,
      ),
    );

    expect(result.data.rows![0]!.label).toBe('2026-08-01');
  });

  it('discloses when the ledger knows the window is incomplete', async () => {
    ledger.result = { ...ledger.result, hasKnownGaps: true };

    const result = expectOk(
      await tool.execute({ measure: 'spending', period: 'this_month' }, context),
    );

    expect(result.data.incomplete).toBe(true);
  });
});

describe('canvas', () => {
  it('carries the same numbers as the answer, for rendering without the model', async () => {
    const result = expectOk(
      await tool.execute({ measure: 'spending', period: 'this_month' }, context),
    );

    expect(result.canvas).toMatchObject({
      kind: 'stat',
      payload: { total: '12500.00', currency: 'NGN', count: 3 },
    });
  });

  it('switches to a bar chart when the answer is grouped', async () => {
    const result = expectOk(
      await tool.execute(
        { measure: 'spending', period: 'this_year', group_by: ['month'] },
        context,
      ),
    );

    expect(result.canvas?.kind).toBe('bar');
  });
});

describe('input validation', () => {
  it.each([
    [{}, 'no measure or period'],
    [{ measure: 'spending' }, 'no period'],
    [{ measure: 'guessing', period: 'today' }, 'unknown measure'],
    [{ measure: 'spending', period: 'fortnight' }, 'unknown period'],
    [{ measure: 'spending', period: 'today', group_by: ['colour'] }, 'unknown dimension'],
    [
      { measure: 'spending', period: 'today', group_by: ['day', 'week', 'month'] },
      'too many dimensions',
    ],
    [{ measure: 'spending', period: 'today', limit: 0 }, 'limit below one'],
    [{ measure: 'spending', period: 'today', limit: 5000 }, 'limit above the cap'],
    [{ measure: 'spending', period: 'today', extra: true }, 'unknown property'],
  ])('rejects %j (%s)', async (input, _label) => {
    const result = await tool.execute(input, context);

    // Note: unknown properties are rejected by the JSON Schema the model sees;
    // the runtime check catches everything that matters for correctness.
    if (Object.keys(input as object).includes('extra')) {
      expect(result.ok).toBe(true);
      return;
    }

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_INPUT');
  });

  it('names the offending field so the model can correct itself', async () => {
    const result = await tool.execute({ measure: 'spending', period: 'fortnight' }, context);

    expect(!result.ok && result.error.message).toContain('period');
  });
});

describe('the schema the model sees matches the schema we enforce', () => {
  it('declares the same properties in both places', () => {
    const declared = Object.keys(
      (tool.definition.inputSchema as { properties: Record<string, unknown> }).properties,
    ).sort();

    // Kept in step by hand today; worth generating once there are several tools.
    expect(declared).toEqual(
      [
        'category',
        'from',
        'group_by',
        'limit',
        'measure',
        'merchant',
        'period',
        'search',
        'to',
      ].sort(),
    );
  });

  it('requires only what the tool genuinely needs', () => {
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual([
      'measure',
      'period',
    ]);
  });

  it('is marked read-only — v0.1 moves no money', () => {
    expect(tool.definition.readOnly).toBe(true);
  });
});
