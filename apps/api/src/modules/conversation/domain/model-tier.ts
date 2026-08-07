/**
 * Model tiers, capabilities and pricing — one source of truth.
 *
 * Measured on live traffic, a single Opus-tier model costs roughly $0.03 a question,
 * which is $8–11 per user per month at ten questions a day. That is not a price a
 * Nigerian consumer product can carry (risk R4), and most questions here are one
 * tool call and one sentence.
 *
 * So the loop starts on a **fast** model and escalates to a **deep** one only when
 * the cheap answer cannot be trusted. Escalation reuses the grounding gate's existing
 * retry path: the same mechanism that catches a fabricated figure is what decides a
 * question needed the better model.
 *
 * Capabilities differ per model and getting them wrong is a 400, not a degradation:
 * `output_config.effort` is rejected outright by Haiku 4.5, and adaptive thinking is
 * not available there either.
 */

export type ModelTier = 'fast' | 'deep';

export interface ModelProfile {
  readonly id: string;
  /** `output_config.effort` is rejected by models that do not support it. */
  readonly supportsEffort: boolean;
  /** Micro-USD per token. Update when pricing changes. */
  readonly inputMicroUsdPerToken: number;
  readonly outputMicroUsdPerToken: number;
}

/** Cache writes bill at 1.25x the input rate; reads at 0.1x. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    supportsEffort: true,
    inputMicroUsdPerToken: 5,
    outputMicroUsdPerToken: 25,
  },
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    supportsEffort: true,
    inputMicroUsdPerToken: 5,
    outputMicroUsdPerToken: 25,
  },
  'claude-fable-5': {
    id: 'claude-fable-5',
    supportsEffort: true,
    inputMicroUsdPerToken: 10,
    outputMicroUsdPerToken: 50,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    supportsEffort: true,
    inputMicroUsdPerToken: 3,
    outputMicroUsdPerToken: 15,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    // Sending `effort` to Haiku 4.5 is a 400, not a no-op.
    supportsEffort: false,
    inputMicroUsdPerToken: 1,
    outputMicroUsdPerToken: 5,
  },
};

/**
 * Looks up a model's profile.
 *
 * Handles dated ids: a request naming the alias `claude-haiku-4-5` comes back from the
 * API as `claude-haiku-4-5-20251001`, so an exact-match lookup misses on every
 * response and cost goes unrecorded. Matching by alias prefix fixes that. No alias in
 * the table is a prefix of another, so the match cannot be ambiguous.
 *
 * Returns null for a genuinely unrecognised id rather than guessing: a wrong
 * capability flag is a failed request, and a wrong price is a cost metric that lies.
 */
export function profileFor(modelId: string): ModelProfile | null {
  const exact = PROFILES[modelId];
  if (exact) return exact;

  for (const profile of Object.values(PROFILES)) {
    if (modelId.startsWith(`${profile.id}-`)) return profile;
  }

  return null;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * Prices all four billable components.
 *
 * `usage.input_tokens` is only the *uncached remainder*, so pricing it alone silently
 * under-reports every cached request — which it did here, by 40–60%, until measured.
 */
export function costMicroUsd(modelId: string, usage: TokenUsage): number | null {
  const profile = profileFor(modelId);
  if (!profile) return null;

  return Math.round(
    usage.inputTokens * profile.inputMicroUsdPerToken +
      usage.cacheCreationInputTokens * profile.inputMicroUsdPerToken * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadInputTokens * profile.inputMicroUsdPerToken * CACHE_READ_MULTIPLIER +
      usage.outputTokens * profile.outputMicroUsdPerToken,
  );
}
