import type { ToolDefinition } from './tool';

/**
 * The model, behind a port.
 *
 * Two reasons this abstraction earns its place. First, the agent loop is the most
 * behaviour-critical code in the product and must be unit-testable without spending
 * tokens or depending on a network. Second, it keeps provider types out of the
 * domain, so the loop reads as "ask, run tools, verify" rather than as SDK plumbing.
 *
 * `raw` is the one deliberate leak: provider message content is replayed back
 * verbatim on the next call. Reconstructing an assistant turn from its text alone
 * would drop thinking blocks and tool-use blocks, which the API requires intact.
 */

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface LlmToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly text: string }
  /** Provider content blocks, echoed back unchanged. */
  | { readonly role: 'assistant'; readonly raw: unknown }
  | { readonly role: 'tool_results'; readonly results: readonly LlmToolResult[] };

export type LlmStopReason = 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' | 'other';

export interface LlmTurn {
  /** Assistant text. Empty when the turn only called tools. */
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: LlmStopReason;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Billed separately from `inputTokens`: writes at 1.25x the input rate, reads at
   * 0.1x. Omitting them under-reports cost, which is worse than not reporting it.
   */
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly model: string;
  /** Opaque provider content, for replay. */
  readonly raw: unknown;
}

export interface LlmRequest {
  /** Stable across users and requests, so it can be cached by the provider. */
  readonly systemStable: string;
  /** Per-user, per-request context. Placed after the cache breakpoint. */
  readonly systemContext: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDefinition[];
}

export interface LlmPort {
  complete(request: LlmRequest): Promise<LlmTurn>;
}

export const LLM_PORT = Symbol.for('atlas.LlmPort');
