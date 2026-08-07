import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Bounded-context dependency graph (ARCHITECTURE §4, ADR-002).
 *
 * A module may import ONLY: the shared kernel, `@shared/*` infrastructure, and the
 * public barrel of the modules listed here. Anything else is a boundary violation
 * and fails the build.
 *
 * Rules of thumb encoded below:
 *  - `ingestion` never writes to `ledger`; it emits TransactionObserved events.
 *  - `intelligence` reads `ledger` but never mutates it.
 *  - `conversation` is the orchestrator (agent tools), so it may read several modules.
 *  - Everything else is a leaf.
 */
const MODULE_DEPENDENCIES = {
  identity: [],
  // Authentication is cross-cutting: any context with an HTTP surface needs to
  // resolve the caller, and that resolution owns identity's data. Contexts may
  // therefore depend on `identity`, but only on its public barrel.
  //
  // `ledger` joined this list when reconciliation gained an HTTP surface — the queue of
  // suspected duplicates and the gap questions both need a user to answer them. Same
  // rationale as the others, not a new exception: the dependency is on the guard and the
  // authenticated-request type, never on identity's internals.
  ledger: ['identity'],
  ingestion: ['identity'],
  memory: [],
  voice: [],
  notifications: [],
  intelligence: ['ledger'],
  conversation: ['identity', 'ledger', 'memory', 'intelligence'],
};

const MODULES = Object.keys(MODULE_DEPENDENCIES);

/** One ESLint config object per module, encoding its allowed imports. */
const boundaryConfigs = MODULES.map((moduleName) => {
  const allowed = MODULE_DEPENDENCIES[moduleName];
  const forbidden = MODULES.filter((m) => m !== moduleName && !allowed.includes(m));

  return {
    files: [`apps/api/src/modules/${moduleName}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          /**
           * Patterns key on the *module name* rather than on path depth.
           *
           * An earlier version banned `../../*` outright to stop relative escapes,
           * but that cannot distinguish climbing within a module
           * (`infrastructure/sql` -> its own `domain`) from escaping into a sibling.
           * Matching the module name catches `../../memory/...` and
           * `@modules/memory` alike, while leaving a module free to navigate its
           * own directories.
           */
          patterns: [
            // Modules this context is not allowed to know about at all.
            ...forbidden.map((m) => ({
              group: [`@modules/${m}`, `@modules/${m}/*`, `**/${m}`, `**/${m}/**`],
              message:
                `Boundary violation: '${moduleName}' may not import '${m}'. ` +
                `Communicate through a domain event on the outbox instead, or amend ` +
                `MODULE_DEPENDENCIES in eslint.config.mjs with an ADR explaining why.`,
            })),
            // Allowed modules may only be reached through their public barrel.
            ...allowed.map((m) => ({
              group: [`@modules/${m}/*`, `**/${m}/**`],
              message:
                `Deep import into '${m}' is not allowed. Import the public barrel ` +
                `'@modules/${m}' so its internals stay replaceable.`,
            })),
          ],
        },
      ],
    },
  };
});

/**
 * Invariant I3 (ADR-003): money is integer minor units, and arithmetic on it happens
 * only inside the Money value object. These selectors catch the actual mistake —
 * raw arithmetic on a `*Minor` quantity — rather than trusting code review.
 */
const moneyArithmeticRules = ['+', '-', '*', '/'].flatMap((operator) => [
  {
    selector: `BinaryExpression[operator='${operator}'] > Identifier[name=/Minor$/]`,
    message:
      'Invariant I3: do not do raw arithmetic on minor-unit amounts. ' +
      'Use the Money value object (plus/minus/allocate/multiplyByRatio) so rounding ' +
      'and currency are handled explicitly.',
  },
  {
    selector: `BinaryExpression[operator='${operator}'] > MemberExpression[property.name=/Minor$/]`,
    message:
      'Invariant I3: do not do raw arithmetic on minor-unit amounts. Use the Money value object.',
  },
]);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'apps/mobile/**',
      'apps/api/prisma/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Invariant I3: floating point has no place in this codebase. ' +
            'Use Money.fromDecimalString() for parsing monetary input.',
        },
      ],
      'no-restricted-syntax': ['error', ...moneyArithmeticRules],
    },
  },
  ...boundaryConfigs,
  {
    /**
     * NestJS resolves constructor dependencies from `design:paramtypes` metadata,
     * which TypeScript only emits for *value* imports. `consistent-type-imports`
     * cannot see that a class used solely as a constructor parameter type is a
     * runtime dependency, so obeying it would rewrite the import and break DI at
     * runtime with no compile-time warning.
     *
     * Disabled for the API only. Packages have no decorators, so the rule keeps
     * its value where it is safe.
     */
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // The Money value object is the one place minor-unit arithmetic is correct.
    files: ['packages/shared-kernel/src/money.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/vitest.config.ts', '**/*.config.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
