import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AtlasTool, ToolDefinition, ToolRegistry } from '../domain/tool';
import { QueryLedgerTool } from './tools/query-ledger.tool';

/**
 * The tool registry.
 *
 * Tools register themselves at boot rather than being listed in a prompt, so the set
 * the model is offered and the set the server can actually execute cannot drift
 * apart. A name the model invents simply has no handler.
 *
 * Definitions are returned in a stable order because they render ahead of the system
 * prompt: reordering them would invalidate the provider's prompt cache on every
 * request.
 */
@Injectable()
export class InMemoryToolRegistry implements ToolRegistry, OnModuleInit {
  private readonly tools = new Map<string, AtlasTool>();

  constructor(private readonly queryLedger: QueryLedgerTool) {}

  onModuleInit(): void {
    this.register(this.queryLedger as AtlasTool);
  }

  register(tool: AtlasTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool '${tool.definition.name}' is already registered`);
    }

    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): AtlasTool | undefined {
    return this.tools.get(name);
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
