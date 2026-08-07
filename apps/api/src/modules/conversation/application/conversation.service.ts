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
  type LlmRequest,
  type LlmToolResult,
  type LlmTurn,
} from '../domain/llm.port';
import { costMicroUsd, type ModelTier, type TokenUsage } from '../domain/model-tier';
import type { CanvasSpec, GroundingFact, ToolContext } from '../domain/tool';
import { TOOL_REGISTRY, type ToolRegistry } from '../domain/tool';
import { buildGroundingCorrection, buildSystemContext, SYSTEM_STABLE } from './system-prompt';

/**
 * The agent loop (ARCHITECTURE §7.1, ADR-005).
 *
 * Ask the model, run whatever tools it calls, then refuse to speak any number the
 * tools did not return.
 *
 * Two mechanisms share one path. The grounding gate decides whether an answer can be
 * trusted; the model router uses that same verdict to decide whether the question
 * needed a better model. The escalation ladder:
 *
 *   fast tier, grounded          → answer (the common case, ~5x cheaper)
 *   fast tier, ungrounded        → escalate to the deep tier, naming the bad figures
 *   deep tier, still ungrounded  → suppress the prose, return the canvas
 *
 * Atlas says less rather than saying something false, and pays for the expensive
 * model only when the cheap one could not be trusted.
 *
 * **A caveat routing does not solve.** The gate verifies magnitudes, not meaning: a
 * cheaper model that queries *last* month when the user said *this* month produces a
 * grounded, real, wrong answer. That is why every reply names the period it queried —
 * so the mistake is visible to the reader — and why the fast tier's period selection
 * is worth measuring rather than assuming.
 */

/** Bounded so a confused model cannot loop indefinitely at the user's expense. */
const MAX_TOOL_ITERATIONS = 5;

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
  /** The model that produced the answer — reveals how often escalation happens. */
  readonly model: string;
  readonly latencyMs: number;
  readonly costMicroUsd: number | null;
  readonly degradedReason?: string;
}

interface MutableUsage {
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
  readonly hasMerchants: boolean;
}

interface LoopOutcome {
  readonly text: string;
  readonly refused: boolean;
  readonly model: string;
}

type PromptFrame = Omit<LlmRequest, 'messages' | 'tier'>;

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
    const canvasRef = { current: null as CanvasSpec | null };

    // Usage is keyed by model: the tiers are priced differently, so a turn that
    // escalates cannot be costed from a single total.
    const usageByModel = new Map<string, MutableUsage>();

    const frame: PromptFrame = {
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

    const settle = (outcome: {
      text: string | null;
      status: GroundingStatus;
      model: string;
      reason?: string;
    }): Promise<ChatAnswer> =>
      this.persistAndReturn({
        context,
        question: input.question,
        text: outcome.text,
        canvas: canvasRef.current,
        status: outcome.status,
        model: outcome.model,
        usageByModel,
        startedAt,
        ...(outcome.reason ? { degradedReason: outcome.reason } : {}),
      });

    // --- first attempt, on the cheap tier ---
    const fast = await this.runLoop(
      'fast',
      frame,
      messages,
      facts,
      canvasRef,
      context,
      usageByModel,
    );

    if (!fast.refused) {
      const verdict = this.gate.verify(fast.text, facts);

      if (verdict.grounded && fast.text !== '') {
        return settle({
          text: fast.text,
          status: verdict.claimsChecked === 0 ? 'NOT_APPLICABLE' : 'PASSED',
          model: fast.model,
        });
      }

      const unverified = verdict.unverifiedClaims.map((claim) => claim.claim);
      this.logger.warn(
        `Fast tier unusable for turn ${turnId} (${unverified.join(', ') || 'no answer produced'}); escalating`,
      );

      if (unverified.length > 0) {
        messages.push({ role: 'user', text: buildGroundingCorrection(unverified) });
      }
    } else {
      this.logger.warn(`Fast tier refused turn ${turnId}; escalating`);
    }

    // --- escalation, on the deep tier ---
    const deep = await this.runLoop(
      'deep',
      frame,
      messages,
      facts,
      canvasRef,
      context,
      usageByModel,
    );

    if (deep.refused) {
      return settle({
        text: 'I am not able to help with that.',
        status: 'NOT_APPLICABLE',
        model: deep.model,
      });
    }

    const retryVerdict = this.gate.verify(deep.text, facts);
    if (retryVerdict.grounded && deep.text !== '') {
      return settle({
        text: deep.text,
        status: retryVerdict.claimsChecked === 0 ? 'NOT_APPLICABLE' : 'REGENERATED',
        model: deep.model,
      });
    }

    // Even the deep tier could not be verified. Suppress the prose; the canvas
    // renders from raw query results and stays trustworthy.
    this.logger.error(`Grounding degraded for turn ${turnId} after escalation`);

    return settle({
      text: null,
      status: 'DEGRADED',
      model: deep.model,
      reason:
        'I could not verify the figures in my answer against your ledger, so I have shown the data instead.',
    });
  }

  /** One tier's tool-calling loop, accumulating facts, canvas and usage as it goes. */
  private async runLoop(
    tier: ModelTier,
    frame: PromptFrame,
    messages: LlmMessage[],
    facts: GroundingFact[],
    canvasRef: { current: CanvasSpec | null },
    context: ToolContext,
    usageByModel: Map<string, MutableUsage>,
  ): Promise<LoopOutcome> {
    let model = tier === 'fast' ? this.env.ANTHROPIC_MODEL_FAST : this.env.ANTHROPIC_MODEL_DEEP;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const turn = await this.llm.complete({ ...frame, tier, messages });

      model = turn.model;
      this.accumulate(usageByModel, turn);

      // Read stop_reason before content: a refusal carries no usable answer.
      if (turn.stopReason === 'refusal') return { text: '', refused: true, model };

      if (turn.toolCalls.length === 0) return { text: turn.text, refused: false, model };

      messages.push({ role: 'assistant', raw: turn.raw });

      const results: LlmToolResult[] = [];
      for (const call of turn.toolCalls) {
        const outcome = await this.runTool(call.name, call.input, context);
        results.push({ toolCallId: call.id, content: outcome.content, isError: outcome.isError });
        facts.push(...outcome.facts);
        if (outcome.canvas) canvasRef.current = outcome.canvas;
      }

      messages.push({ role: 'tool_results', results });
    }

    // Ran out of iterations without settling. Returned as an empty answer so the
    // caller escalates or degrades, rather than shipping half-formed text.
    this.logger.warn(`Tier ${tier} exhausted ${MAX_TOOL_ITERATIONS} iterations`);

    return { text: '', refused: false, model };
  }

  private accumulate(usageByModel: Map<string, MutableUsage>, turn: LlmTurn): void {
    const current = usageByModel.get(turn.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    current.inputTokens += turn.inputTokens;
    current.outputTokens += turn.outputTokens;
    current.cacheCreationInputTokens += turn.cacheCreationInputTokens;
    current.cacheReadInputTokens += turn.cacheReadInputTokens;

    usageByModel.set(turn.model, current);
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

      // Surfaced to the model rather than aborting the turn: it can often recover by
      // asking a narrower question.
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

      const [categoryCount, merchantCount] = await Promise.all([
        tx.category.count({ where: { userId } }),
        tx.merchant.count({ where: { userId } }),
      ]);

      return {
        displayName: user.displayName,
        timeZone: user.timezone,
        currency: user.primaryCurrency as CurrencyCode,
        hasCategories: categoryCount > 0,
        hasMerchants: merchantCount > 0,
      };
    });
  }

  /**
   * What the ledger does and does not contain, stated to the model.
   *
   * The highest-value part of the per-request prompt while Atlas is mid build:
   * without it, the likeliest failure is a confident answer to a category question
   * the ledger cannot answer at all.
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

    if (!profile.hasMerchants) {
      // Measured: without this, the model reaches for the merchant filter when the
      // user names a shop, gets an unresolved miss, and reports it cannot find them —
      // even though a description search would have found the transaction.
      notes.push(
        'Merchants are not identified as records yet. When the user names a shop or company, use the search field to match the alert description rather than the merchant filter.',
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
    model: string;
    usageByModel: Map<string, MutableUsage>;
    startedAt: number;
    degradedReason?: string;
  }): Promise<ChatAnswer> {
    const latencyMs = this.clock.nowMs() - args.startedAt;
    const totals = this.totalUsage(args.usageByModel);
    const cost = this.totalCost(args.usageByModel);

    await this.tenantScope.run(args.context.userId, async (tx) => {
      await this.persistTurns(tx, args, totals, cost, latencyMs);
    });

    return {
      sessionId: args.context.sessionId,
      turnId: args.context.turnId,
      text: args.text,
      canvas: args.canvas,
      groundingStatus: args.status,
      model: args.model,
      latencyMs,
      costMicroUsd: cost,
      ...(args.degradedReason ? { degradedReason: args.degradedReason } : {}),
    };
  }

  private totalUsage(usageByModel: Map<string, MutableUsage>): TokenUsage {
    const totals: MutableUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    for (const usage of usageByModel.values()) {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      totals.cacheReadInputTokens += usage.cacheReadInputTokens;
    }

    return totals;
  }

  /** Summed per model, because the tiers are priced differently. */
  private totalCost(usageByModel: Map<string, MutableUsage>): number | null {
    let total = 0;
    let priced = false;

    for (const [modelId, usage] of usageByModel) {
      const cost = costMicroUsd(modelId, usage);

      if (cost === null) {
        this.logger.warn(`No pricing for model '${modelId}'; cost not recorded for this turn`);
        return null;
      }

      total += cost;
      priced = true;
    }

    return priced ? total : null;
  }

  private async persistTurns(
    tx: TenantClient,
    args: {
      context: ToolContext;
      question: string;
      text: string | null;
      status: GroundingStatus;
      model: string;
    },
    totals: TokenUsage,
    cost: number | null,
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
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheCreationInputTokens: totals.cacheCreationInputTokens,
        cacheReadInputTokens: totals.cacheReadInputTokens,
        costMicroUsd: cost,
      },
    });
  }
}
