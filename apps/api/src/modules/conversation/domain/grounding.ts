import type { GroundingFact } from './tool';

/**
 * The grounding gate (ADR-005, invariant I1).
 *
 * After the model produces a response, every numeric claim in the text is checked
 * against the facts the turn's tools actually returned. A number the tools never
 * produced is treated as a hallucination, full stop.
 *
 * Escalation is deliberate:
 *   PASSED       — every claim traced to a tool result.
 *   REGENERATED  — first attempt failed; a second was requested and passed.
 *   DEGRADED     — still unverified, so the spoken answer is suppressed and the
 *                  user gets the canvas ("here is the data") instead. Atlas says
 *                  less rather than saying something false.
 *
 * A rising DEGRADED rate is the earliest signal of a prompt regression, which is
 * why the outcome is persisted per turn.
 */

export type GroundingStatus = 'NOT_APPLICABLE' | 'PASSED' | 'REGENERATED' | 'DEGRADED';

export interface UnverifiedClaim {
  /** The literal text that could not be traced, e.g. "₦45,200". */
  readonly claim: string;
  readonly reason: 'NO_MATCHING_FACT' | 'VALUE_MISMATCH';
  /** Closest declared fact, when one exists — useful for debugging prompts. */
  readonly nearestFact?: GroundingFact;
}

export interface GroundingVerdict {
  readonly grounded: boolean;
  readonly unverifiedClaims: readonly UnverifiedClaim[];
  /** Count of numeric claims examined; zero means nothing needed verification. */
  readonly claimsChecked: number;
}

export interface GroundingGate {
  verify(responseText: string, facts: readonly GroundingFact[]): GroundingVerdict;
}

export const GROUNDING_GATE = Symbol.for('atlas.GroundingGate');
