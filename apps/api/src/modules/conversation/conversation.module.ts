import { Module } from '@nestjs/common';

/**
 * Conversation — sessions, turns, the agent loop, the tool registry and the
 * grounding gate. The only module that talks to Claude.
 *
 * Keeping the model behind this boundary is what makes invariant I1 enforceable:
 * there is exactly one place where a response can be generated, and exactly one
 * place where it is checked before a user hears it.
 *
 * Implementations land in M1 (text) and M3 (voice).
 */
@Module({})
export class ConversationModule {}
