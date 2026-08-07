# Development

## What runs today (M1 complete — Atlas answers questions)

| Piece                    | State                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `packages/shared-kernel` | Builds, 66 tests, lint clean                                                                  |
| `apps/api`               | Builds, boots, 311 unit tests, lint clean                                                     |
| SMS template engine      | Complete — parsing, transforms, publication gate, dedupe keys                                 |
| Ledger                   | Read path, admission, balance anchoring; RLS enforced and proven                              |
| Sync endpoint            | `POST /v1/sync/observations` — authenticated, validated, idempotent                           |
| Grounding gate           | Complete — significant-figure rounding rule, 35 tests                                         |
| Period resolution        | Complete — named periods resolved server-side, DST-correct, 41 tests                          |
| `query_ledger` tool      | Complete — no model-authored ids, no model date arithmetic, unresolved filters return nothing |
| Agent loop               | Complete — tool loop, grounding escalation, turn persistence, 19 integration tests            |
| `POST /v1/chat`          | Complete, device-authenticated                                                                |
| **Live, end to end**     | **Working against Claude Opus 5** — verified answers from real ledger data                    |
| Reconciliation           | Not started (M2)                                                                              |
| Durable outbox relay     | Not started (M2, Temporal)                                                                    |
| User authentication      | Not started — no HTTP device-enrolment route yet, deliberately                                |
| `apps/mobile`            | Dart sources written, **never compiled** — Flutter is not installed                           |
| CI                       | Written with a Postgres service, **not yet run** — nothing has been pushed                    |

### Talking to Atlas from the terminal

```bash
pnpm --filter @atlas/api run build
node apps/api/dist/cli/ask.js --user <userId> "how much did I spend this month?"
```

Runs the real loop against the real ledger and the real model. A development tool,
not a product surface — it bypasses HTTP and device auth by design.

## Measured on real data — and it changes a recommendation

Verified live against Claude Opus 5 with a seeded ledger. Answers are correct and
grounded; **cost and latency are both far outside target**, and they point the same way.

| Metric               | Measured            | Target                 |
| -------------------- | ------------------- | ---------------------- |
| Cost per question    | **$0.026 – $0.036** | needs to be ~10x lower |
| Latency per question | **9 – 15 s**        | < 1.5 s to first audio |

At ~$0.03 a question and ten questions a day, inference alone is **$8–11 per user
per month** — roughly ₦13,000–17,600. That is not a viable price for a Nigerian
consumer product, and it is risk R4 arriving with hard numbers rather than as a
worry. Latency is 6–10x over target for the same reason: two sequential Opus 5 calls
per question.

Both point at the same conclusion: **Opus 5 is the wrong default for the common
case.** The levers, in order of impact:

1. **Model routing.** Haiku 4.5 is $1/$5 per MTok against Opus 5's $5/$25 — 5x
   cheaper and materially faster. Most questions here are one tool call and one
   sentence. Route to Haiku, escalate to Opus only when the cheap model fails or the
   grounding gate degrades. This is the architectural fix.
2. **Shorter answers.** Output is roughly half the cost, and every reply currently
   appends a data-completeness caveat because the system prompt asks for it. Saying
   it once per session rather than once per answer cuts output materially.
3. **Streaming** (M3 anyway). Does nothing for cost, but collapses _perceived_
   latency: first token in ~2s instead of a 10s wait.

Lowering `ANTHROPIC_EFFORT` to `low` was measured and **did not help** — latency is
dominated by round trips and generation, not thinking depth. Do not reach for effort
as the latency lever here.

### Cost telemetry was wrong at first

Worth recording because the failure was silent: the first implementation priced only
`usage.input_tokens`, which reports the _uncached remainder_. With prompt caching
active (the cacheable prefix measures 1,521 tokens against Opus 5's 512 minimum),
that under-reported real cost by 40–60%. Cache writes bill at 1.25x the input rate
and reads at 0.1x, so all four components are now priced and all four are persisted
per turn — which also makes cache hit rate observable.

## The M1 core, and what it guarantees

Two pieces carry most of the product risk, so both are pure functions with no
infrastructure dependency and heavy test coverage.

### SMS template engine (`modules/ingestion/domain/parsing`)

Deterministic parsing of bank alerts against templates delivered as data (ADR-004).
Claude authors candidate templates offline; only this engine runs in production, and
it never guesses — a message either parses exactly or fails with a reason.

Three things worth knowing:

- **Date formats are explicit, never inferred.** `07/08/2026` is 7 August or
  8 July depending on convention, and both parse cleanly. Templates must state the
  format, and fixtures prove it.
- **Timestamps carry an institution offset.** Bank alerts state local wall-clock
  time with no zone. Africa/Lagos is UTC+1 with no DST, so a fixed offset is exact —
  but expanding to a DST zone needs a real IANA database, not a wider number.
- **A matched-but-broken template fails loudly** rather than falling through to an
  older version. Falling through risks a different, subtly wrong reading of the same
  message, and it would waste the template flywheel on a defect that is not a new
  bank format.

The validator is the publication gate and doubles as a security control: templates
are LLM-authored regex executed on user phones, so it rejects nested quantifiers
(catastrophic backtracking would pin a CPU and drain a battery as _configuration_),
backreferences, and any template whose fixtures do not pass.

### Ledger query compiler (`modules/ledger`)

Turns a validated `LedgerQueryPlan` into parameterised SQL. This is where
model-authored input meets the database, so: no value is ever interpolated, every
identifier comes from an allowlist, and money aggregates are cast to `text` and
parsed as BigInt. `AVG()` is deliberately unused — averages are derived in `Money`
with explicit rounding (invariant I2).

Two traps the tests pin down:

- **Ordering uses the numeric aggregate, not the `::text` alias.** Sorting `'9'`
  against `'1000'` as text inverts every "what did I spend most on" answer.
- **`ILIKE` patterns escape LIKE metacharacters.** Without it, searching for `50%`
  matches every transaction.

## Prerequisites

Already present: Node 25.9, pnpm 11.16, git.

Still needed:

```bash
brew install colima docker docker-compose   # container runtime — see note below
brew install --cask flutter
brew install --cask temurin                 # JDK, for Android builds
```

Then start the VM once; it persists across reboots:

```bash
colima start --cpu 4 --memory 6 --disk 60
```

If `docker compose` is not found, link the Homebrew plugin:

```bash
mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
```

**Choosing a container runtime.** No runtime needs a Docker account, and every image
in `docker-compose.yml` is public. `pnpm infra:up` behaves identically on all three,
so this is a cost/licensing preference, not a technical one:

| Runtime            | Licence                                                 | Notes                                     |
| ------------------ | ------------------------------------------------------- | ----------------------------------------- |
| **Colima**         | Apache-2.0, free for any use                            | CLI only; what the commands above install |
| **OrbStack**       | Free tier is "personal, non-commercial"; Pro $8/user/mo | Fastest, best UX on macOS                 |
| **Docker Desktop** | Free below a company size/revenue threshold             | Heaviest of the three                     |

Atlas is intended to be a commercial product, so OrbStack's free tier stops applying
at some point and Docker Desktop's does above their threshold. Colima has no such
condition. If you prefer OrbStack, `brew install --cask orbstack` and skip the
`colima start` step — everything else is unchanged.

Docker Hub rate-limits anonymous pulls by IP. Five images pulled once and cached
locally is well inside it; if you ever see `toomanyrequests`, a free Docker Hub
account and `docker login` raises the ceiling.

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

Then apply the schema. The committed migration already contains the row-level
security policies, so this is a single step:

```bash
pnpm --filter @atlas/api exec prisma migrate deploy
```

**When you add a future migration**, Prisma will not generate the RLS parts — it does
not model policies. Any migration that creates a user-scoped table needs the policy
appended by hand:

```bash
pnpm --filter @atlas/api exec prisma migrate dev --create-only --name <name>
# then append the relevant policy SQL into that migration's migration.sql
pnpm --filter @atlas/api exec prisma migrate deploy
```

Keeping the policies inside the migration rather than in a separate script is
deliberate: it means no environment can ever come up with tables but no isolation.

Start the API:

```bash
pnpm dev
```

## Everyday commands

```bash
pnpm verify        # format check, lint, typecheck, test — what CI runs
pnpm test          # unit tests only, no infrastructure needed
pnpm build
pnpm db:studio     # browse the database

# Integration tests: real Postgres, real migration, real row-level security.
# Needs `pnpm infra:up` first.
pnpm --filter @atlas/api run test:integration
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

**Every ledger read must go through `TenantScope`.** Row-level security reads
`atlas.user_id`, which is transaction-local, so a query issued outside a scope
matches no policy and returns zero rows. Forgetting the wrapper therefore shows up as
"no data" in development rather than as a cross-tenant leak in production — the
failure direction we can live with.

**`DateTime` in Prisma is `timestamp WITHOUT time zone` by default.** Every DateTime
field carries `@db.Timestamptz(3)` for a reason: `AT TIME ZONE` means opposite things
on the two types. On `timestamptz` it converts an instant _into_ a zone; on
`timestamp` it interprets the value _as being in_ that zone and hands back a
`timestamptz`. With the default mapping, monthly totals were being shifted an hour
**backwards** instead of forwards — silently, and only visibly wrong near midnight.
If you add a DateTime column, annotate it.

**Rebuild `shared-kernel` after changing it.** `apps/api` resolves
`@atlas/shared-kernel` to its compiled `dist`, so an edit to the package is invisible
to the API's tests until `pnpm build` runs. Turbo handles this for `pnpm verify`;
running a single test file directly does not.

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
