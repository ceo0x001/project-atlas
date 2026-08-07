# Development

## What runs today (M1 complete — Atlas answers questions)

| Piece                    | State                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `packages/shared-kernel` | Builds, 66 tests, lint clean                                                                   |
| `apps/api`               | Builds, boots, 319 unit tests, lint clean                                                      |
| SMS template engine      | Complete — parsing, transforms, publication gate, dedupe keys                                  |
| Ledger                   | Read path, admission, balance anchoring; RLS enforced and proven                               |
| Sync endpoint            | `POST /v1/sync/observations` — authenticated, validated, idempotent                            |
| Grounding gate           | Complete — significant-figure rounding rule, 35 tests                                          |
| Period resolution        | Complete — named periods resolved server-side, DST-correct, 41 tests                           |
| `query_ledger` tool      | Complete — no model-authored ids, no model date arithmetic, unresolved filters return nothing  |
| Agent loop               | Complete — tool loop, grounding escalation, turn persistence, 19 integration tests             |
| `POST /v1/chat`          | Complete, device-authenticated                                                                 |
| **Live, end to end**     | **Working on two-tier routing** — Haiku 4.5 answers, Opus 5 on escalation                      |
| Reconciliation           | Not started (M2)                                                                               |
| Durable outbox relay     | Not started (M2, Temporal)                                                                     |
| User authentication      | Not started — no HTTP device-enrolment route yet, deliberately                                 |
| `apps/mobile`            | `flutter analyze` + `flutter test` **green in CI**; never compiled locally (no SDK)            |
| CI                       | **Green on first run** — Backend 1.5 min, Mobile 2 min ([ci.yml](../.github/workflows/ci.yml)) |

### Talking to Atlas from the terminal

```bash
pnpm --filter @atlas/api run build
node apps/api/dist/cli/ask.js --user <userId> "how much did I spend this month?"
```

Runs the real loop against the real ledger and the real model. A development tool,
not a product surface — it bypasses HTTP and device auth by design.

## CI

Green on its first run against a clean `ubuntu-latest`: `pnpm install --frozen-lockfile`,
format/lint/typecheck, build, `prisma migrate deploy` (which applies the row-level
security policies and the managed-index safeguard, not just the schema), then the
integration suite against a fresh `pgvector/pgvector:pg17`. Backend 1.5 min, Mobile 2 min.

That first run is the only real evidence the stack builds anywhere but this laptop —
`pgcrypto` is present in the pg17 contrib set, the migration ordering holds, and the
Flutter sources in `apps/mobile` do actually analyse and test, which had never been
executed anywhere before.

**The workflow currently declares `REDIS_URL` but provisions no Redis service.** It
passes only because nothing opens a connection yet — the env schema validates the URL as
a string, it never dials it. The first code that actually reaches for Redis will fail in
CI with an error that looks like a code defect, and the instinct will be to debug the
code rather than the workflow. Either drop the variable until something needs it, or add
the service container in the same commit as the code that dials it, where the reason is
self-evident.

## Measured on real data — model routing

Both figures below are measured live against a seeded ledger, not estimated.

| Metric              | Opus 5 only  | Haiku-first routing | Change          |
| ------------------- | ------------ | ------------------- | --------------- |
| Cost per question   | $0.026–0.036 | **$0.0042**         | **~7x cheaper** |
| Latency             | 9–15 s       | **3.0–3.6 s**       | **~3x faster**  |
| Correct answers     | 5/5          | **4/4**             | unchanged       |
| Escalations to Opus | n/a          | **0 of 4**          | —               |

At ten questions a day that is **~$1.25 per user per month** — roughly ₦2,000, which a
consumer product can carry. The single-tier figure was $8–11, which it could not.

How it works: the loop asks the fast tier first, and the grounding gate's verdict is
what decides whether the question needed a better model. A fabricated figure triggers
the same escalation path that already existed for regeneration, so routing added a
decision, not a second mechanism.

**What routing does not fix.** The gate verifies magnitudes, not meaning. A cheaper
model that queries _last_ month when the user said _this_ month returns a grounded,
real, wrong answer. Mitigation is that every reply names the period it queried, so a
reader can catch it — but this is the failure mode to watch as the question mix widens,
and it is the reason the fast tier's period selection is measured rather than assumed.

### Two defects the measurement exposed

**Cost was silently not recorded at all.** A request naming the alias
`claude-haiku-4-5` comes back as `claude-haiku-4-5-20251001`, so the exact-match
pricing lookup missed on every response and stored `null`. The null was deliberate —
better than a wrong number — but it meant the cost SLO had no data. Fixed by matching
on the alias prefix.

**The model reported it could not find a merchant that was there.** With no merchant
records populated, it reached for the `merchant` filter, got an unresolved miss, and
honestly reported the miss — when a description search would have found the
transaction. Fixed by telling the model, in the per-request data notes, to search
descriptions while merchants are unpopulated. "What did I spend at Shoprite?" went
from _"I couldn't find a merchant called Shoprite"_ to **₦7,500**.

Both were only visible by running real questions and reading the telemetry.

### Prompt caching does not apply to the fast tier yet

The minimum cacheable prefix is model-dependent and **not** monotonic across
generations: 512 tokens on Opus 5 but **4,096 on Haiku 4.5**. Our cacheable prefix
(tool schemas plus the stable system prompt) measures 1,521 tokens, so it caches on
the deep tier and silently does not on the fast one — visible as
`cacheReadInputTokens: 0` on every Haiku turn.

This is a tradeoff, not a bug, and it resolves itself: input is ~83% of the fast
tier's cost, so caching would take $0.0042 to roughly $0.001, and the prefix will cross
4,096 tokens naturally as tools are added. Do not pad the prompt to reach it.

Lowering `ANTHROPIC_EFFORT` was measured and did **not** reduce latency — the cost is
round trips and generation, not thinking depth. Model choice was the lever.

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
