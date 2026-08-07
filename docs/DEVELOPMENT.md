# Development

## What runs today (M0)

| Piece                    | State                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `packages/shared-kernel` | Builds, 54 tests pass, lint clean                                                                    |
| `apps/api`               | Builds, boots, 14 tests pass, lint clean; `/health/live` 200, `/health/ready` 503 without a database |
| Prisma schema            | Validates; client generates. **No migration has been run** — no Postgres available yet               |
| `docker-compose.yml`     | Written, **never executed** — Docker is not installed                                                |
| `apps/mobile`            | Dart sources written, **never compiled** — Flutter is not installed                                  |
| CI                       | Written, not yet run                                                                                 |

Nothing above is claimed to work beyond what that table says.

## Prerequisites

Already present: Node 25.9, pnpm 11.16, git.

Still needed:

```bash
brew install --cask orbstack      # Docker runtime — lighter and faster than Docker Desktop on macOS
brew install --cask flutter
brew install --cask temurin       # JDK, for Android builds
```

A **physical mid-range Android device** is also required from M1 (ADR-006
Amendment 1) — SMS ingestion cannot be tested on an emulator, and a flagship hides
the latency and battery behaviour real users will see.

## First run

```bash
pnpm install
cp .env.example apps/api/.env
pnpm infra:up
pnpm run db:generate
```

Then the migration, which needs one manual step because Prisma does not model
row-level security:

```bash
pnpm --filter @atlas/api exec prisma migrate dev --create-only --name init
cat apps/api/prisma/sql/001_row_level_security.sql >> apps/api/prisma/migrations/*_init/migration.sql
pnpm --filter @atlas/api exec prisma migrate dev
```

Appending rather than running separately keeps RLS inside the migration history, so
a fresh environment can never come up with policies missing.

Start the API:

```bash
pnpm dev
```

## Everyday commands

```bash
pnpm verify        # format check, lint, typecheck, test — what CI runs
pnpm test          # tests only
pnpm build
pnpm db:studio     # browse the database
```

Local service UIs once `pnpm infra:up` is running: Temporal on
`http://localhost:8233`, Jaeger traces on `http://localhost:16686` (set
`OTEL_ENABLED=true` first).

## The guardrails, and why they will shout at you

Three invariants are enforced by tooling rather than by review. Each will fail your
build, and each is deliberate.

**Money arithmetic.** `amountMinor + feeMinor` is a lint error. Money is integer
minor units inside a `Money` value object (ADR-003); addition, splitting and
scaling go through its methods so currency and rounding are always explicit.
`parseFloat` is banned outright. A schema test additionally rejects any `Float` or
`Decimal` column whose name ends in `Minor`.

**Module boundaries.** `ledger` importing `memory` is a lint error. The allowed
dependency graph lives in `MODULE_DEPENDENCIES` in `eslint.config.mjs`
(ARCHITECTURE §4). Modules talk through domain events on the outbox; deep imports
into another module's internals are blocked so its innards stay replaceable. If you
genuinely need a new edge, add it there _and_ write an ADR saying why.

**Environment.** The process refuses to boot on invalid configuration rather than
failing later on the one request that needed the missing key. Secrets are optional
in development and mandatory in production.

## Things that will surprise you

**`import type` breaks dependency injection.** NestJS resolves constructor
dependencies from `design:paramtypes` metadata, which TypeScript only emits for
value imports. `consistent-type-imports` is therefore disabled for `apps/api`; it
stays on everywhere else.

**BigInt does not serialise.** `JSON.stringify` throws on BigInt, and every money
column is one. `installBigIntSerializer()` in `main.ts` teaches it to emit a
_string_ — never a number, since routing kobo through a double is the exact failure
this codebase exists to prevent.

**The API starts without a database.** It logs an error and reports
`/health/ready` 503 rather than exiting. A process that crash-loops on a transient
Postgres blip turns a recoverable incident into an outage.

## Deferred, on purpose

These are decisions, not oversights:

- **Prisma 7.** We are on 6.19. Prisma 7's default path (driver adapters +
  queryCompiler) is a substantive change deserving its own evaluation rather than a
  drive-by during scaffolding. The schema is portable between majors. Revisit
  before M2.
- **Mobile dependency set.** drift, riverpod, dio and the SMS platform channel get
  pinned against a real Flutter install in M1, not guessed at now.
- **Security headers, rate limiting, auth.** M0 exposes only `/health`. These land
  in M1 with the first real endpoint.
- **Docker image tags** in `docker-compose.yml` are pinned but unverified. Expect to
  adjust one or two on first `pnpm infra:up`.
