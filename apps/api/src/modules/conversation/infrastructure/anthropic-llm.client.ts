import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '@config/env';
import type { LlmPort, LlmRequest, LlmStopReason, LlmTurn } from '../domain/llm.port';

/**
 * The Anthropic implementation of the model port.
 *
 * Notable request choices, each deliberate:
 *
 * - **No `temperature` / `top_p` / `top_k`.** Removed on Opus 5; sending any of them
 *   is a 400. Behaviour is steered by the prompt instead.
 * - **`thinking` omitted.** Opus 5 runs adaptive thinking by default, and omitting
 *   the field is the portable choice across models. Explicitly *disabling* thinking
 *   would be actively unsafe here: on Opus 5 a thinking-disabled turn can emit a
 *   tool call as plain text — the call silently never runs and the turn still looks
 *   successful — and can leak `<thinking>` tags into user-visible output. Effort is
 *   the lever for cost and latency, not disabling thinking.
 * - **`max_tokens` generous.** It caps thinking *and* response text together, so a
 *   tight value truncates the answer rather than the reasoning.
 * - **Cache breakpoint on the stable system block.** Tools render before system, so
 *   one breakpoint there caches the tool schemas and the invariant instructions
 *   across every user. Per-user context follows it, uncached.
 */

const MAX_OUTPUT_TOKENS = 16_000;

@Injectable()
export class AnthropicLlmClient implements LlmPort {
  private readonly client: Anthropic | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    // Constructed lazily-ish: a missing key must not stop the service booting, so
    // that /health works and the failure surfaces on the request that needs it.
    this.client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    if (!this.client) {
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY is not configured');
    }

    const message = await this.client.messages.create({
      model: this.env.ANTHROPIC_MODEL_CONVERSATION,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: this.env.ANTHROPIC_EFFORT },
      system: [
        { type: 'text', text: request.systemStable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: request.systemContext },
      ],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
      })),
      messages: request.messages.map((entry) => {
        switch (entry.role) {
          case 'user':
            return { role: 'user' as const, content: entry.text };
          case 'assistant':
            // Replayed verbatim: rebuilding this from text alone would drop
            // thinking and tool_use blocks the API requires intact.
            return {
              role: 'assistant' as const,
              content: entry.raw as Anthropic.ContentBlockParam[],
            };
          case 'tool_results':
            return {
              role: 'user' as const,
              content: entry.results.map((result) => ({
                type: 'tool_result' as const,
                tool_use_id: result.toolCallId,
                content: result.content,
                is_error: result.isError,
              })),
            };
        }
      }),
    });

    return {
      // A refusal carries no usable content, so read stop_reason before content.
      text: message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim(),
      toolCalls: message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input })),
      stopReason: mapStopReason(message.stop_reason),
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      model: message.model,
      raw: message.content,
    };
  }
}

function mapStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}
