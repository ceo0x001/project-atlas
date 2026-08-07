/**
 * Public surface of the ingestion context. Other modules import from here and
 * nowhere else inside `ingestion` — enforced by eslint.config.mjs.
 */
export * from './domain/events';
export * from './domain/parse-template';
export * from './domain/parsing/dedupe-key';
export * from './domain/parsing/template-engine';
export * from './domain/parsing/template-validator';
export * from './domain/parsing/transforms';
export { IngestionModule } from './ingestion.module';
