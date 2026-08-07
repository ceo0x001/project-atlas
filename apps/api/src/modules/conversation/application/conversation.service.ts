import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type Clock,
  CLOCK,
  type CurrencyCode,
  newId,
  type SessionId,
  type TurnId,
  type UserId,
} from '@atlas/shared-kernel';
import { ENV, type Env } from '@config/env';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import { GROUNDING_GATE, type GroundingGate, type GroundingStatus } from '../domain/grounding';
import {
  type LlmMessage,
  LLM_PORT,
  type LlmPort,
  type LlmToolResult,
  type LlmTurn,
} from '../domain/llm.port';
import type { CanvasSpec, GroundingFact, ToolContext } from '../domain/tool';
import { TOOL_REGISTRY, type ToolRegistry } from '../domain/tool';
import { buildGroundingCorrection, buildSystemContext, SYSTEM_STABLE } from './system-prompt';

/**
 * The agent loop (ARCHITECTURE §7.1, ADR-005).
 *
 * Ask the model, run whatever tools it calls, then refuse to speak any number the
 * tools did not return. The escalation is the point:
 *
 *   grounded            → answer as written
 *   ungrounded once     → one corrective attempt naming the untraceable figures
 *   ungrounded twice    → suppress the prose entirely and return the canvas
 *
 * Atlas says less rather than saying something false. Every outcome is recorded per
 * turn, because a rising DEGRADED rate is the earliest signal of a prompt regression.
 */

/** Bounded so a confused model cannot loop indefinitely at the user's expense. */
const MAX_TOOL_ITERATIONS = 5;

/**
 * Micro-USD per token, per model. Recording a *wrong* cost is worse than recording
 * none, so an unknown model stores null rather than a guess. Update when pricing does.
 */
const PRICING_MICRO_USD_PER_TOKEN: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** Cache writes cost 1.25x the input rate; reads cost 0.1x. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface AskInput {
  readonly userId: UserId;
  readonly question: string;
  /** Continues an existing conversation when supplied. */
  readonly sessionId?: SessionId;
}

export interface ChatAnswer {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** Null when the grounding gate degraded the turn. */
  readonly text: string | null;
  readonly canvas: CanvasSpec | null;
  readonly groundingStatus: GroundingStatus;
  readonly latencyMs: number;
  /** Populated when the answer was suppressed, so a client can explain itself. */
  readonly degradedReason?: string;
}

/** Everything billable in a turn. Cache tokens are priced differently, so they
 *  cannot be folded into `inputTokens` without misreporting cost. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface UserProfile {
  readonly displayName: string | null;
  readonly timeZone: string;
  readonly currency: CurrencyCode;
  readonly hasCategories: boolean;
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    @Inject(TOOL_REGISTRY) private readonly tools: ToolRegistry,
    @Inject(GROUNDING_GATE) private readonly gate: GroundingGate,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly tenantScope: TenantScope,
  ) {}

  async ask(input: AskInput): Promise<ChatAnswer> {
    const startedAt = this.clock.nowMs();

    const profile = await this.loadProfile(input.userId);
    const sessionId = await this.ensureSession(input.userId, input.sessionId);
    const turnId = newId<'TurnId'>();

    const context: ToolContext = {
      userId: input.userId,
      sessionId,
      turnId,
      requestedAt: this.clock.now(),
      timeZone: profile.timeZone,
      currency: profile.currency,
    };

    const messages: LlmMessage[] = [{ role: 'user', text: input.question }];
    const facts: GroundingFact[] = [];
    let canvas: CanvasSpec | null = null;
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    let model = this.env.ANTHROPIC_MODEL_CONVERSATION;

    const request = {
      systemStable: SYSTEM_STABLE,
      systemContext: buildSystemContext({
        displayName: profile.displayName,
        timeZone: profile.timeZone,
        currency: profile.currency,
        localDateTime: this.localDateTime(profile.timeZone),
        dataNotes: this.dataNotes(profile),
      }),
      tools: this.tools.definitions(),
    };

    let answerText = '';
    let refused = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const turn = await this.llm.complete({ ...request, messages });

      accumulate(usage, turn);
      model = turn.model;

      // Read stop_reason before content: a refusal carries no usable answer, and
      // indexing into content unconditionally would throw or return nothing.
      if (turn.stopReason === 'refusal') {
        refused = true;
        break;
      }

      if (turn.toolCalls.length === 0) {
        answerText = turn.text;
        break;
      }

      messages.push({ role: 'assistant', raw: turn.raw });

      const results: LlmToolResult[] = [];
      for (const call of turn.toolCalls) {
        const outcome = await this.runTool(call.name, call.input, context);
        results.push({ toolCallId: call.id, content: outcome.content, isError: outcome.isError });
        facts.push(...outcome.facts);
        canvas = outcome.canvas ?? canvas;
      }

      messages.push({ role: 'tool_results', results });
    }

    if (refused) {
      return this.persistAndReturn({
        context,
        question: input.question,
        text: 'I am not able to help with that.',
        canvas: null,
        status: 'NOT_APPLICABLE',
        startedAt,
        usage,
        model,
      });
    }

    const verdict = this.gate.verify(answerText, facts);
    if (verdict.grounded) {
      return this.persistAndReturn({
        context,
        question: input.question,
        text: answerText,
        canvas,
        status: verdict.claimsChecked === 0 ? 'NOT_APPLICABLE' : 'PASSED',
        startedAt,
        usage,
        model,
      });
    }

    // One corrective attempt, naming the specific untraceable figures.
    const unverified = verdict.unverifiedClaims.map((claim) => claim.claim);
    this.logger.warn(`Grounding failed for turn ${turnId}: ${unverified.join(', ')}`);

    messages.push({ role: 'user', text: buildGroundingCorrection(unverified) });

    const retry = await this.llm.complete({ ...request, messages });
    accumulate(usage, retry);

    const retryVerdict = this.gate.verify(retry.text, facts);
    if (retryVerdict.grounded && retry.stopReason !== 'refusal') {
      return this.persistAndReturn({
        context,
        question: input.question,
        text: retry.text,
        canvas,
        status: 'REGENERATED',
        startedAt,
        usage,
        model,
      });
    }

    // Still unverified. Suppress the prose; the canvas renders from raw query
    // results and so is trustworthy even when the narration is not.
    this.logger.error(`Grounding degraded for turn ${turnId} after one retry`);

    return this.persistAndReturn({
      context,
      question: input.question,
      text: null,
      canvas,
      status: 'DEGRADED',
      startedAt,
      usage,
      model,
      degradedReason:
        'I could not verify the figures in my answer against your ledger, so I have shown the data instead.',
    });
  }

  private async runTool(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<{
    content: string;
    isError: boolean;
    facts: readonly GroundingFact[];
    canvas?: CanvasSpec;
  }> {
    const tool = this.tools.get(name);

    if (!tool) {
      // A name the model invented. Telling it so is more useful than failing.
      return { content: `No tool named '${name}' exists.`, isError: true, facts: [] };
    }

    try {
      const result = await tool.execute(rawInput, context);

      if (!result.ok) {
        return {
          content: `${result.error.code}: ${result.error.message}`,
          isError: true,
          facts: [],
        };
      }

      return {
        content: JSON.stringify(result.value.data),
        isError: false,
        facts: result.value.groundingFacts,
        ...(result.value.canvas ? { canvas: result.value.canvas } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool ${name} threw: ${reason}`);

      // Surface the failure to the model rather than aborting the turn: it can
      // often recover by asking a narrower question.
      return { content: `The tool failed: ${reason}`, isError: true, facts: [] };
    }
  }

  private async loadProfile(userId: UserId): Promise<UserProfile> {
    return this.tenantScope.run(userId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { displayName: true, timezone: true, primaryCurrency: true },
      });

      if (!user) throw new Error(`User ${userId} not found`);

      const categoryCount = await tx.category.count({ where: { userId } });

      return {
        displayName: user.displayName,
        timeZone: user.timezone,
        currency: user.primaryCurrency as CurrencyCode,
        hasCategories: categoryCount > 0,
      };
    });
  }

  /**
   * What the ledger does and does not contain, stated to the model.
   *
   * This is the highest-value part of the per-request prompt while Atlas is mid
   * build: without it, the likeliest failure is a confident answer to a category
   * question the ledger cannot answer at all.
   */
  private dataNotes(profile: UserProfile): readonly string[] {
    const notes = [
      "Transactions come from the bank alerts on the user's phone. Anything their bank did not send an alert for is not in the ledger.",
    ];

    if (!profile.hasCategories) {
      notes.push(
        'Transactions are not categorised yet. A category filter will come back unresolved — say so rather than answering about all spending.',
      );
    }

    return notes;
  }

  private localDateTime(timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(this.clock.now());
  }

  private async ensureSession(userId: UserId, existing?: SessionId): Promise<SessionId> {
    if (existing) return existing;

    const sessionId = newId<'SessionId'>();

    await this.tenantScope.run(userId, (tx) =>
      tx.conversationSession.create({ data: { id: sessionId, userId, channel: 'TEXT' } }),
    );

    return sessionId;
  }

  private async persistAndReturn(args: {
    context: ToolContext;
    question: string;
    text: string | null;
    canvas: CanvasSpec | null;
    status: GroundingStatus;
    startedAt: number;
    usage: TokenUsage;
    model: string;
    degradedReason?: string;
  }): Promise<ChatAnswer> {
    const latencyMs = this.clock.nowMs() - args.startedAt;

    await this.tenantScope.run(args.context.userId, async (tx) => {
      await this.persistTurns(tx, args, latencyMs);
    });

    return {
      sessionId: args.context.sessionId,
      turnId: args.context.turnId,
      text: args.text,
      canvas: args.canvas,
      groundingStatus: args.status,
      latencyMs,
      ...(args.degradedReason ? { degradedReason: args.degradedReason } : {}),
    };
  }

  private async persistTurns(
    tx: TenantClient,
    args: {
      context: ToolContext;
      question: string;
      text: string | null;
      status: GroundingStatus;
      usage: TokenUsage;
      model: string;
    },
    latencyMs: number,
  ): Promise<void> {
    // Both halves of the exchange, in one transaction: a transcript missing the
    // question is not a transcript, and a half-written turn is worse than none.
    await tx.conversationTurn.create({
      data: {
        id: newId<'TurnId'>(),
        sessionId: args.context.sessionId,
        userId: args.context.userId,
        role: 'USER',
        content: args.question,
      },
    });

    await tx.conversationTurn.create({
      data: {
        id: args.context.turnId,
        sessionId: args.context.sessionId,
        userId: args.context.userId,
        role: 'ASSISTANT',
        content: args.text,
        groundingStatus: args.status,
        model: args.model,
        latencyMs,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cacheCreationInputTokens: args.usage.cacheCreationInputTokens,
        cacheReadInputTokens: args.usage.cacheReadInputTokens,
        costMicroUsd: this.costMicroUsd(args.model, args.usage),
      },
    });
  }

  /**
   * Prices all four billable components.
   *
   * Cache tokens are the easy thing to miss: `usage.input_tokens` reports only the
   * *uncached* remainder, so pricing that field alone silently under-reports every
   * cached request. Writes cost 1.25x the input rate, reads 0.1x.
   */
  private costMicroUsd(model: string, usage: TokenUsage): number | null {
    const pricing = PRICING_MICRO_USD_PER_TOKEN[model];

    if (!pricing) {
      this.logger.warn(`No pricing for model '${model}'; cost not recorded`);
      return null;
    }

    return Math.round(
      usage.inputTokens * pricing.input +
        usage.cacheCreationInputTokens * pricing.input * CACHE_WRITE_MULTIPLIER +
        usage.cacheReadInputTokens * pricing.input * CACHE_READ_MULTIPLIER +
        usage.outputTokens * pricing.output,
    );
  }
}

function accumulate(usage: TokenUsage, turn: LlmTurn): void {
  usage.inputTokens += turn.inputTokens;
  usage.outputTokens += turn.outputTokens;
  usage.cacheCreationInputTokens += turn.cacheCreationInputTokens;
  usage.cacheReadInputTokens += turn.cacheReadInputTokens;
}
