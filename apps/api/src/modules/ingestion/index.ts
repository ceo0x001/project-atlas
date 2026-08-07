/**
 * Public surface of the ingestion context. Other modules import from here and
 * nowhere else inside `ingestion` — enforced by eslint.config.mjs.
 *
 * Event contracts deliberately live in `@shared/events/contracts`, not here: an
 * event is a shared language between contexts and belongs to neither side.
 */
export * from './domain/parse-template';
export * from './domain/parsing/dedupe-key';
export * from './domain/parsing/template-engine';
export * from './domain/parsing/template-validator';
export * from './domain/parsing/transforms';
export { MAX_STATEMENT_BYTES } from './api/statement.dto';
export {
  type ImportOutcome,
  type ImportStatementInput,
  StatementImportService,
} from './application/statement-import.service';
export { IngestionModule } from './ingestion.module';
