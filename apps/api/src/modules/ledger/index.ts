/**
 * Public surface of the ledger context. Other modules may import from here and
 * nowhere else inside `ledger` — enforced by eslint.config.mjs.
 */
export * from './domain/ledger-query';
export * from './domain/ledger-query.port';
export * from './domain/types';
export { LedgerModule } from './ledger.module';
