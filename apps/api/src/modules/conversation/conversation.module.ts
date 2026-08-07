import { Module } from '@nestjs/common';
import { GROUNDING_GATE } from './domain/grounding';
import { NumericGroundingGate } from './domain/numeric-grounding-gate';

/**
 * Conversation — sessions, turns, the agent loop, the tool registry and the
 * grounding gate. The only module that talks to Claude.
 *
 * Keeping the model behind this boundary is what makes invariant I1 enforceable:
 * there is exactly one place where a response can be generated, and exactly one
 * place where it is checked before a user hears it.
 *
 * The gate is in place and tested. The tool registry, the Claude client and the
 * turn-persistence layer are the remaining M1 work.
 */
@Module({
  providers: [{ provide: GROUNDING_GATE, useClass: NumericGroundingGate }],
  exports: [GROUNDING_GATE],
})
export class ConversationModule {}
