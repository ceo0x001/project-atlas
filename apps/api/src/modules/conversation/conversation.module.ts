import { Module } from '@nestjs/common';
import { IdentityModule } from '@modules/identity';
import { LedgerModule } from '@modules/ledger';
import { ChatController } from './api/chat.controller';
import { ConversationService } from './application/conversation.service';
import { InMemoryToolRegistry } from './application/tool-registry.service';
import { QueryLedgerTool } from './application/tools/query-ledger.tool';
import { GROUNDING_GATE } from './domain/grounding';
import { LLM_PORT } from './domain/llm.port';
import { NumericGroundingGate } from './domain/numeric-grounding-gate';
import { TOOL_REGISTRY } from './domain/tool';
import { AnthropicLlmClient } from './infrastructure/anthropic-llm.client';

/**
 * Conversation — sessions, turns, the agent loop, the tool registry and the
 * grounding gate. The only module that talks to Claude.
 *
 * Keeping the model behind this boundary is what makes invariant I1 enforceable:
 * there is exactly one place a response can be generated, and exactly one place it
 * is checked before a user sees it.
 *
 * Voice (M3) attaches to this same path — speech in front, speech behind — rather
 * than introducing a second way to answer a question.
 */
@Module({
  imports: [IdentityModule, LedgerModule],
  controllers: [ChatController],
  providers: [
    QueryLedgerTool,
    { provide: TOOL_REGISTRY, useClass: InMemoryToolRegistry },
    { provide: GROUNDING_GATE, useClass: NumericGroundingGate },
    { provide: LLM_PORT, useClass: AnthropicLlmClient },
    ConversationService,
  ],
  exports: [GROUNDING_GATE, ConversationService],
})
export class ConversationModule {}
