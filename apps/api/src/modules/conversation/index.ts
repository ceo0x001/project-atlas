/**
 * Public surface of the conversation context.
 *
 * Event contracts and the ledger query plan live elsewhere; what this module
 * exposes is the ability to ask a question and the grounding contract that governs
 * the answer.
 */
export {
  type AskInput,
  type ChatAnswer,
  ConversationService,
} from './application/conversation.service';
export * from './domain/claim-extraction';
export * from './domain/grounding';
export * from './domain/llm.port';
export { NumericGroundingGate } from './domain/numeric-grounding-gate';
export * from './domain/period';
export * from './domain/tool';
export { ConversationModule } from './conversation.module';
