import { isUlid } from '@atlas/shared-kernel';
import { z } from 'zod';

/** A question is a sentence, not a document; the cap keeps a turn's cost bounded. */
export const MAX_QUESTION_LENGTH = 1_000;

export const askSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  /** Continues an existing conversation. Omit to start a new one. */
  sessionId: z.string().refine(isUlid, { message: 'must be a ULID' }).optional(),
});

export type AskRequest = z.infer<typeof askSchema>;

export interface AskResponse {
  readonly sessionId: string;
  readonly turnId: string;
  /**
   * Null when the grounding gate suppressed the prose. A client must render
   * `canvas` and `notice` in that case rather than showing an empty bubble.
   */
  readonly answer: string | null;
  readonly canvas: unknown | null;
  readonly notice?: string;
  /** Exposed so the client can show, and telemetry can track, verification state. */
  readonly grounding: string;
  readonly latencyMs: number;
}
