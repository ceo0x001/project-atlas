import type { Result, SessionId, TurnId, UserId } from '@atlas/shared-kernel';

/**
 * The tool registry — the model's only route to data (ADR-005).
 *
 * Shapes deliberately mirror MCP (name + JSON Schema + handler) so that exposing
 * these as real MCP servers later is a transport change rather than a redesign.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input, passed verbatim to the model. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Read-only tools can run without confirmation. v0.1 has no write tools that
   * move money (ARCHITECTURE §1); this flag is the gate that keeps it that way.
   */
  readonly readOnly: boolean;
}

export interface ToolContext {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly requestedAt: Date;
}

export type GroundingFactKind = 'money' | 'count' | 'percentage' | 'date';

/**
 * A single verifiable value produced by a tool.
 *
 * This is the mechanism behind the grounding gate: tools declare every number they
 * returned, and the gate refuses to let the assistant speak a number that is not
 * in this set. Facts carry a canonical string form so comparison never routes
 * through a float.
 */
export interface GroundingFact {
  readonly label: string;
  readonly value: string;
  readonly kind: GroundingFactKind;
}

/** Instruction for the client to render evidence on screen, straight from query results. */
export interface CanvasSpec {
  readonly kind: 'table' | 'bar' | 'line' | 'list' | 'stat';
  readonly title: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ToolInvocationResult<TData = unknown> {
  /** Structured payload returned to the model. */
  readonly data: TData;
  /** Every number in `data` the model is allowed to repeat. */
  readonly groundingFacts: readonly GroundingFact[];
  /** Optional visual, rendered from raw results without passing through the model. */
  readonly canvas?: CanvasSpec;
}

export interface ToolExecutionError {
  readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'UNAVAILABLE' | 'FORBIDDEN';
  readonly message: string;
}

export interface AtlasTool<TInput = unknown, TData = unknown> {
  readonly definition: ToolDefinition;
  execute(
    input: TInput,
    context: ToolContext,
  ): Promise<Result<ToolInvocationResult<TData>, ToolExecutionError>>;
}

export interface ToolRegistry {
  register(tool: AtlasTool): void;
  get(name: string): AtlasTool | undefined;
  definitions(): readonly ToolDefinition[];
}

export const TOOL_REGISTRY = Symbol.for('atlas.ToolRegistry');
