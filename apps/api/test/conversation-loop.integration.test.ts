import { PrismaClient } from '@prisma/client';
import { FixedClock, idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { ConversationService } from '../src/modules/conversation/application/conversation.service';
import { InMemoryToolRegistry } from '../src/modules/conversation/application/tool-registry.service';
import { QueryLedgerTool } from '../src/modules/conversation/application/tools/query-ledger.tool';
import type { LlmPort, LlmRequest, LlmTurn } from '../src/modules/conversation/domain/llm.port';
import { NumericGroundingGate } from '../src/modules/conversation/domain/numeric-grounding-gate';
import { PrismaLedgerQueryRepository } from '../src/modules/ledger/infrastructure/prisma-ledger-query.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantScope } from '../src/shared/prisma/tenant-scope';

/**
 * The agent loop, end to end, against a real ledger.
 *
 * The model is scripted rather than live: the behaviour under test is what Atlas does
 * with a model's output — including when that output is wrong — and a live model
 * cannot be made to hallucinate on demand. The real API is exercised separately.
 */

const env = parseEnv();
const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);
const tenantScope = new TenantScope(app);

/** 7 August 2026, 14:23 Lagos — so "this month" is August 2026. */
const clock = new FixedClock(new Date('2026-08-07T13:23:45Z'));

const userId = idFromSeed<'UserId'>(5_000) as UserId;
const accountId = idFromSeed<'AccountId'>(5_100);

/** Returns scripted turns in order and records what it was asked. */
class ScriptedLlm implements LlmPort {
  readonly requests: LlmRequest[] = [];
  private queue: LlmTurn[] = [];

  script(...turns: Partial<LlmTurn>[]): void {
    this.queue = turns.map((turn) => ({
      text: '',
      toolCalls: [],
      stopReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      model: 'claude-opus-5',
      raw: [],
      ...turn,
    }));
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });

    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedLlm ran out of turns — the loop asked more than expected');

    return next;
  }
}

const llm = new ScriptedLlm();
let service: ConversationService;

/** The model asking for August spending — the call the happy path expects. */
const askedForAugustSpending = {
  stopReason: 'tool_use' as const,
  toolCalls: [
    { id: 'toolu_1', name: 'query_ledger', input: { measure: 'spending', period: 'this_month' } },
  ],
};

async function wipe(): Promise<void> {
  await owner.conversationTurn.deleteMany({ where: { userId } });
  await owner.conversationSession.deleteMany({ where: { userId } });
  await owner.transaction.deleteMany({ where: { userId } });
  await owner.account.deleteMany({ where: { userId } });
  await owner.category.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
}

beforeAll(async () => {
  await wipe();

  await owner.user.create({
    data: {
      id: userId,
      phoneE164: '+2348000005000',
      displayName: 'Ada',
      timezone: 'Africa/Lagos',
      primaryCurrency: 'NGN',
    },
  });

  await owner.account.create({
    data: { id: accountId, userId, label: 'Current', type: 'CURRENT', currency: 'NGN' },
  });

  // Three August debits totalling ₦12,500.00, plus a credit that must be excluded.
  await owner.transaction.createMany({
    data: [
      {
        id: idFromSeed<'TransactionId'>(5_201),
        userId,
        accountId,
        amountMinor: 500_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-02T10:00:00Z'),
        description: 'SHOPRITE',
      },
      {
        id: idFromSeed<'TransactionId'>(5_202),
        userId,
        accountId,
        amountMinor: 500_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-05T10:00:00Z'),
        description: 'TRANSFER TO MUSA',
      },
      {
        id: idFromSeed<'TransactionId'>(5_203),
        userId,
        accountId,
        amountMinor: 250_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-07T10:00:00Z'),
        description: 'MTN VTU',
      },
      {
        id: idFromSeed<'TransactionId'>(5_204),
        userId,
        accountId,
        amountMinor: 25_000_000n,
        currency: 'NGN',
        direction: 'CREDIT',
        occurredAt: new Date('2026-08-01T08:00:00Z'),
        description: 'SALARY',
      },
    ],
  });

  const registry = new InMemoryToolRegistry(
    new QueryLedgerTool(new PrismaLedgerQueryRepository(tenantScope), clock),
  );
  registry.onModuleInit();

  service = new ConversationService(
    llm,
    registry,
    new NumericGroundingGate(),
    clock,
    env,
    tenantScope,
  );
});

afterAll(async () => {
  await wipe();
  await owner.$disconnect();
  await app.$disconnect();
});

beforeEach(async () => {
  llm.requests.length = 0;
  await owner.conversationTurn.deleteMany({ where: { userId } });
  await owner.conversationSession.deleteMany({ where: { userId } });
});

describe('the grounded happy path', () => {
  it('answers a spending question from the ledger', async () => {
    llm.script(askedForAugustSpending, {
      text: 'You spent about ₦12,500 in August 2026, across 3 transactions.',
    });

    const answer = await service.ask({ userId, question: 'How much did I spend this month?' });

    expect(answer.groundingStatus).toBe('PASSED');
    expect(answer.text).toContain('12,500');
    expect(answer.canvas).toMatchObject({ kind: 'stat' });
  });

  it('excluded the salary credit — spending means debits', async () => {
    llm.script(askedForAugustSpending, { text: 'You spent ₦12,500.00.' });

    const answer = await service.ask({ userId, question: 'How much did I spend this month?' });

    // The ₦250,000 credit would have dominated any total that included it.
    expect(answer.groundingStatus).toBe('PASSED');
  });

  it('accepts a natural rounding of the real figure', async () => {
    llm.script(askedForAugustSpending, { text: 'Roughly ₦13,000 so far this month.' });

    // 12,500 to two significant figures is 13,000.
    expect((await service.ask({ userId, question: 'spend?' })).groundingStatus).toBe('PASSED');
  });

  it('records the turn with its grounding outcome, tokens and cost', async () => {
    llm.script(askedForAugustSpending, { text: 'You spent ₦12,500.00.' });

    await service.ask({ userId, question: 'How much did I spend this month?' });

    const turns = await owner.conversationTurn.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        content: true,
        groundingStatus: true,
        inputTokens: true,
        outputTokens: true,
        costMicroUsd: true,
        latencyMs: true,
      },
    });

    expect(turns.map((turn) => turn.role)).toEqual(['USER', 'ASSISTANT']);
    expect(turns[0]!.content).toBe('How much did I spend this month?');
    expect(turns[1]!.groundingStatus).toBe('PASSED');
    // Two model calls at 100 in / 50 out, priced at Opus 5's 5 and 25 µUSD per token.
    expect(turns[1]!.inputTokens).toBe(200);
    expect(turns[1]!.outputTokens).toBe(100);
    // No cache activity in the scripted turns, so this reduces to input+output.
    expect(turns[1]!.costMicroUsd).toBe(200 * 5 + 100 * 25);
    expect(turns[1]!.latencyMs).not.toBeNull();
  });
});

describe('a fabricated figure is caught', () => {
  it('regenerates once and accepts a corrected answer', async () => {
    llm.script(
      askedForAugustSpending,
      { text: 'You spent ₦99,999.00 this month.' },
      { text: 'You spent ₦12,500.00 this month.' },
    );

    const answer = await service.ask({ userId, question: 'How much did I spend this month?' });

    expect(answer.groundingStatus).toBe('REGENERATED');
    expect(answer.text).toContain('12,500');
  });

  it('names the specific untraceable figure in the correction', async () => {
    llm.script(
      askedForAugustSpending,
      { text: 'You spent ₦99,999.00 this month.' },
      { text: 'You spent ₦12,500.00.' },
    );

    await service.ask({ userId, question: 'How much did I spend this month?' });

    const correction = llm.requests
      .at(-1)!
      .messages.filter((message) => message.role === 'user')
      .at(-1)!;

    expect(correction).toMatchObject({ role: 'user' });
    expect((correction as { text: string }).text).toContain('99,999');
  });

  it('suppresses the answer entirely when the second attempt is also unverifiable', async () => {
    llm.script(
      askedForAugustSpending,
      { text: 'You spent ₦99,999.00.' },
      { text: 'Actually you spent ₦88,888.00.' },
    );

    const answer = await service.ask({ userId, question: 'How much did I spend this month?' });

    expect(answer.groundingStatus).toBe('DEGRADED');
    expect(answer.text).toBeNull();
    // The canvas renders from raw query results, so it survives the suppression.
    expect(answer.canvas).toMatchObject({ kind: 'stat' });
    expect(answer.degradedReason).toContain('could not verify');
  });

  it('persists DEGRADED so a rising rate is visible in telemetry', async () => {
    llm.script(
      askedForAugustSpending,
      { text: 'You spent ₦99,999.00.' },
      { text: 'You spent ₦77,777.00.' },
    );

    await service.ask({ userId, question: 'How much did I spend this month?' });

    const assistant = await owner.conversationTurn.findFirst({
      where: { userId, role: 'ASSISTANT' },
      select: { groundingStatus: true, content: true },
    });

    expect(assistant!.groundingStatus).toBe('DEGRADED');
    expect(assistant!.content).toBeNull();
  });

  it('rejects a number invented with no tool call at all', async () => {
    // The critical case: the model answers confidently without querying.
    llm.script({ text: 'Your balance is ₦120,000.00.' }, { text: 'Your balance is ₦120,000.00.' });

    const answer = await service.ask({ userId, question: "What's my balance?" });

    expect(answer.groundingStatus).toBe('DEGRADED');
    expect(answer.text).toBeNull();
  });
});

describe('answers with no figures', () => {
  it('passes through when there is nothing to verify', async () => {
    llm.script({ text: 'I can look that up — which account did you mean?' });

    const answer = await service.ask({ userId, question: 'How am I doing?' });

    expect(answer.groundingStatus).toBe('NOT_APPLICABLE');
    expect(answer.text).toContain('which account');
  });
});

describe('unresolved filters', () => {
  it('reports an unknown category instead of answering about everything', async () => {
    llm.script(
      {
        stopReason: 'tool_use',
        toolCalls: [
          {
            id: 'toolu_2',
            name: 'query_ledger',
            input: { measure: 'spending', period: 'this_month', category: 'food' },
          },
        ],
      },
      { text: "I'm not categorising your transactions yet, so I can't break out food spending." },
    );

    const answer = await service.ask({ userId, question: 'How much did I spend on food?' });

    // No figure was returned, so there is nothing to verify — and crucially the
    // ₦12,500 total was never offered as if it were a food total.
    expect(answer.groundingStatus).toBe('NOT_APPLICABLE');
    expect(answer.text).toContain('not categorising');
  });
});

describe('failure handling', () => {
  it('tells the model when it invents a tool name, and keeps going', async () => {
    llm.script(
      {
        stopReason: 'tool_use',
        toolCalls: [{ id: 'toolu_3', name: 'get_bank_balance', input: {} }],
      },
      { text: 'I can only look at your transaction history.' },
    );

    const answer = await service.ask({ userId, question: 'call my bank' });

    expect(answer.groundingStatus).toBe('NOT_APPLICABLE');

    const toolResults = llm.requests.at(-1)!.messages.find((m) => m.role === 'tool_results');
    expect(toolResults).toBeDefined();
    expect(JSON.stringify(toolResults)).toContain('No tool named');
  });

  it('feeds a rejected tool input back so the model can correct itself', async () => {
    llm.script(
      {
        stopReason: 'tool_use',
        toolCalls: [
          {
            id: 'toolu_4',
            name: 'query_ledger',
            input: { measure: 'spending', period: 'fortnight' },
          },
        ],
      },
      { text: 'Let me try that differently.' },
    );

    await service.ask({ userId, question: 'spending for the fortnight' });

    const toolResults = llm.requests.at(-1)!.messages.find((m) => m.role === 'tool_results');
    expect(JSON.stringify(toolResults)).toContain('INVALID_INPUT');
  });

  it('surfaces a refusal without reading response content', async () => {
    llm.script({ stopReason: 'refusal', text: '' });

    const answer = await service.ask({ userId, question: 'something disallowed' });

    expect(answer.text).toBe('I am not able to help with that.');
    expect(answer.groundingStatus).toBe('NOT_APPLICABLE');
  });
});

describe('prompt construction', () => {
  it('caches the invariant instructions and keeps volatile context separate', async () => {
    llm.script({ text: 'Hello.' });

    await service.ask({ userId, question: 'hi' });

    const request = llm.requests[0]!;

    // The stable half must not carry the date, or the provider cache would be
    // invalidated for every user, every day.
    expect(request.systemStable).toContain('source of truth');
    expect(request.systemStable).not.toContain('2026');
    expect(request.systemContext).toContain('Africa/Lagos');
    expect(request.systemContext).toContain('Ada');
  });

  it('tells the model what the ledger does not contain', async () => {
    llm.script({ text: 'Hello.' });

    await service.ask({ userId, question: 'hi' });

    // No categories exist for this user, so the model must be told.
    expect(llm.requests[0]!.systemContext).toContain('not categorised yet');
  });

  it('offers the tool schema, in a stable order for cache stability', async () => {
    llm.script({ text: 'Hello.' });

    await service.ask({ userId, question: 'hi' });

    expect(llm.requests[0]!.tools.map((tool) => tool.name)).toEqual(['query_ledger']);
  });
});

describe('sessions', () => {
  it('starts a session and returns its id', async () => {
    llm.script({ text: 'Hello.' });

    const answer = await service.ask({ userId, question: 'hi' });

    expect(answer.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('continues an existing session when given one', async () => {
    llm.script({ text: 'First.' }, { text: 'Second.' });

    const first = await service.ask({ userId, question: 'hi' });
    const second = await service.ask({
      userId,
      question: 'and again',
      sessionId: first.sessionId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(await owner.conversationSession.count({ where: { userId } })).toBe(1);
    expect(await owner.conversationTurn.count({ where: { userId } })).toBe(4);
  });
});
