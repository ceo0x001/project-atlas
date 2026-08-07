-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('CLIENT', 'INGESTION_NODE', 'CLIENT_AND_INGESTION_NODE');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('SMS_READ', 'RAW_TEXT_UPLOAD', 'EMAIL_FORWARDING', 'PUSH_NOTIFICATIONS', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CURRENT', 'SAVINGS', 'DOMICILIARY', 'WALLET', 'CASH', 'CREDIT_CARD');

-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('RULE', 'MODEL', 'USER');

-- CreateEnum
CREATE TYPE "ObservationSource" AS ENUM ('SMS', 'EMAIL', 'STATEMENT', 'USER_STATED', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "IngestionChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "TemplateAuthor" AS ENUM ('SYSTEM', 'LLM', 'HUMAN');

-- CreateEnum
CREATE TYPE "StatementImportStatus" AS ENUM ('PENDING', 'PARSING', 'RECONCILING', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InsightType" AS ENUM ('SPENDING_ANOMALY', 'RECURRING_DETECTED', 'RECURRING_MISSED', 'LOW_BALANCE_BEFORE_PAYDAY', 'BALANCE_DISCONTINUITY', 'GOAL_PROGRESS', 'WEEKLY_DIGEST', 'CATEGORY_TREND');

-- CreateEnum
CREATE TYPE "InsightSeverity" AS ENUM ('INFO', 'NOTABLE', 'URGENT');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('NEW', 'SEEN', 'ACTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecurrenceCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'IRREGULAR');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('USER_STATED', 'INFERRED', 'DERIVED');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('VOICE', 'TEXT');

-- CreateEnum
CREATE TYPE "TurnRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "GroundingStatus" AS ENUM ('NOT_APPLICABLE', 'PASSED', 'REGENERATED', 'DEGRADED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-NG',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "primaryCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deactivatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "role" "DeviceRole" NOT NULL,
    "model" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "pushToken" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "smsSenderIds" TEXT[],
    "logoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT,
    "label" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "currency" TEXT NOT NULL,
    "accountNumberEnc" BYTEA,
    "accountNumberLast4" TEXT,
    "currentBalanceMinor" BIGINT,
    "balanceAsOf" TIMESTAMPTZ(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "bookedAt" TIMESTAMPTZ(3),
    "description" TEXT NOT NULL,
    "narration" TEXT,
    "balanceAfterMinor" BIGINT,
    "merchantId" TEXT,
    "categoryId" TEXT,
    "categorySource" "CategorySource",
    "categoryConfidence" DOUBLE PRECISION,
    "recurringSeriesId" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_observations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT,
    "accountId" TEXT,
    "institutionId" TEXT,
    "deviceId" TEXT,
    "source" "ObservationSource" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "balanceAfterMinor" BIGINT,
    "description" TEXT,
    "rawReference" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "parsedByTemplateId" TEXT,
    "statementImportId" TEXT,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "defaultCategoryId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rateNumerator" BIGINT NOT NULL,
    "rateDenominator" BIGINT NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parse_templates" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "channel" "IngestionChannel" NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "matchPattern" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL,
    "fixtures" JSONB NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "author" "TemplateAuthor" NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "parse_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parse_failures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT,
    "senderId" TEXT NOT NULL,
    "channel" "IngestionChannel" NOT NULL,
    "textHash" TEXT NOT NULL,
    "redactedText" TEXT,
    "consentGranted" BOOLEAN NOT NULL DEFAULT false,
    "resolvedByTemplateId" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parse_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_imports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "status" "StatementImportStatus" NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER,
    "observationCount" INTEGER,
    "openingBalanceMinor" BIGINT,
    "closingBalanceMinor" BIGINT,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "workflowId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insights" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "InsightType" NOT NULL,
    "severity" "InsightSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'NEW',
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_evidence" (
    "insightId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "insight_evidence_pkey" PRIMARY KEY ("insightId","transactionId")
);

-- CreateTable
CREATE TABLE "recurring_series" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT,
    "categoryId" TEXT,
    "label" TEXT NOT NULL,
    "cadence" "RecurrenceCadence" NOT NULL,
    "intervalDays" INTEGER,
    "expectedAmountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "nextExpectedAt" TIMESTAMPTZ(3),
    "confidence" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "source" "FactSource" NOT NULL,
    "provenance" JSONB,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episodes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "summary" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(1024),

    CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "channel" "ConversationChannel" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_turns" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TurnRole" NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "toolResults" JSONB,
    "groundingStatus" "GroundingStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "model" TEXT,
    "timeToFirstTokenMs" INTEGER,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicroUsd" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneE164_key" ON "users"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE INDEX "consents_userId_scope_idx" ON "consents"("userId", "scope");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE INDEX "transactions_userId_occurredAt_idx" ON "transactions"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_userId_accountId_occurredAt_idx" ON "transactions"("userId", "accountId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_userId_categoryId_occurredAt_idx" ON "transactions"("userId", "categoryId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_userId_merchantId_occurredAt_idx" ON "transactions"("userId", "merchantId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transaction_observations_userId_accountId_occurredAt_idx" ON "transaction_observations"("userId", "accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "transaction_observations_userId_transactionId_idx" ON "transaction_observations"("userId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_observations_userId_dedupeKey_key" ON "transaction_observations"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "categories_userId_slug_key" ON "categories"("userId", "slug");

-- CreateIndex
CREATE INDEX "merchants_normalizedName_idx" ON "merchants"("normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_userId_normalizedName_key" ON "merchants"("userId", "normalizedName");

-- CreateIndex
CREATE INDEX "fx_rates_base_quote_asOf_idx" ON "fx_rates"("base", "quote", "asOf" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_base_quote_asOf_key" ON "fx_rates"("base", "quote", "asOf");

-- CreateIndex
CREATE INDEX "parse_templates_status_channel_idx" ON "parse_templates"("status", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "parse_templates_institutionId_channel_version_key" ON "parse_templates"("institutionId", "channel", "version");

-- CreateIndex
CREATE INDEX "parse_failures_senderId_createdAt_idx" ON "parse_failures"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "parse_failures_userId_createdAt_idx" ON "parse_failures"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "statement_imports_userId_createdAt_idx" ON "statement_imports"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "insights_userId_status_generatedAt_idx" ON "insights"("userId", "status", "generatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "insights_userId_dedupeKey_key" ON "insights"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "insight_evidence_transactionId_idx" ON "insight_evidence"("transactionId");

-- CreateIndex
CREATE INDEX "recurring_series_userId_nextExpectedAt_idx" ON "recurring_series"("userId", "nextExpectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "facts_supersededById_key" ON "facts"("supersededById");

-- CreateIndex
CREATE INDEX "facts_userId_subject_predicate_effectiveFrom_idx" ON "facts"("userId", "subject", "predicate", "effectiveFrom" DESC);

-- CreateIndex
CREATE INDEX "episodes_userId_occurredAt_idx" ON "episodes"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "conversation_sessions_userId_startedAt_idx" ON "conversation_sessions"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "conversation_turns_sessionId_createdAt_idx" ON "conversation_turns"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_occurredAt_idx" ON "outbox_events"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurringSeriesId_fkey" FOREIGN KEY ("recurringSeriesId") REFERENCES "recurring_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_parsedByTemplateId_fkey" FOREIGN KEY ("parsedByTemplateId") REFERENCES "parse_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_observations" ADD CONSTRAINT "transaction_observations_statementImportId_fkey" FOREIGN KEY ("statementImportId") REFERENCES "statement_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_defaultCategoryId_fkey" FOREIGN KEY ("defaultCategoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_templates" ADD CONSTRAINT "parse_templates_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_failures" ADD CONSTRAINT "parse_failures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_failures" ADD CONSTRAINT "parse_failures_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_failures" ADD CONSTRAINT "parse_failures_resolvedByTemplateId_fkey" FOREIGN KEY ("resolvedByTemplateId") REFERENCES "parse_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Appended from prisma/sql/001_row_level_security.sql (see docs/DEVELOPMENT.md)
-- Kept inside the migration so no environment can come up without policies.
-- ============================================================================

-- Row-level security, vector and search indexes.
--
-- Prisma does not model any of this, so it is applied as raw SQL appended to the
-- initial migration (see docs/DEVELOPMENT.md for the exact command sequence).
--
-- ============================================================================
-- Why this is not decoration
-- ============================================================================
-- The application already scopes every query by user_id. RLS is defence in depth:
-- one forgotten WHERE clause in a finance product is an unrecoverable event, and
-- "we were careful" is not a security control.
--
-- Two details make the difference between real isolation and false confidence:
--
--   1. FORCE ROW LEVEL SECURITY. Policies do not apply to a table's owner by
--      default. Migrations run as the owner; the application must NOT. Without
--      FORCE, an app connected as the owner silently bypasses every policy here.
--
--   2. The application connects as `atlas_app`, a role with no BYPASSRLS and no
--      ownership. Every transaction sets `atlas.user_id`, and the policy compares
--      against it. A transaction that forgets to set it sees zero rows — failing
--      closed, which is the only acceptable direction to fail.
--
-- The application-side wiring (SET LOCAL per transaction) lands in M1 alongside
-- the first real repository.

-- ============================================================================
-- Application role
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_app') THEN
    -- Password is set per environment; development uses the compose default.
    CREATE ROLE atlas_app LOGIN PASSWORD 'atlas_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO atlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO atlas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO atlas_app;

-- Tables created by future migrations inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atlas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO atlas_app;

-- ============================================================================
-- Tenant isolation policies
-- ============================================================================

-- Tables owned entirely by one user: a row is visible only when its userId
-- matches the current transaction's setting.
--
-- NOTE ON QUOTING: Prisma generates camelCase column names, so every reference
-- from raw SQL must be double-quoted ("userId", not user_id). Unquoted identifiers
-- are folded to lower case by Postgres and will not resolve.
DO $$
DECLARE
  target text;
  user_scoped_tables text[] := ARRAY[
    'devices',
    'consents',
    'accounts',
    'transactions',
    'transaction_observations',
    'parse_failures',
    'statement_imports',
    'insights',
    'insight_evidence',
    'recurring_series',
    'facts',
    'episodes',
    'conversation_sessions',
    'conversation_turns'
  ];
BEGIN
  FOREACH target IN ARRAY user_scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("userId" = current_setting(''atlas.user_id'', true))
         WITH CHECK ("userId" = current_setting(''atlas.user_id'', true))',
      target
    );
  END LOOP;
END
$$;

-- The users table keys on `id` rather than `user_id`.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (id = current_setting('atlas.user_id', true))
  WITH CHECK (id = current_setting('atlas.user_id', true));

-- Categories and merchants hold both system rows (user_id IS NULL, readable by
-- everyone) and user-defined rows (readable only by their owner). Writes are
-- always restricted to the owner, so no user can modify a system row.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['categories', 'merchants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("userId" IS NULL OR "userId" = current_setting(''atlas.user_id'', true))
         WITH CHECK ("userId" = current_setting(''atlas.user_id'', true))',
      target
    );
  END LOOP;
END
$$;

-- Deliberately NOT under RLS: `institutions`, `parse_templates` and `fx_rates` are
-- shared reference data containing nothing user-specific. `outbox_events` is
-- infrastructure written and drained by the process itself, never served to a
-- client; it stays owner-only and is not granted to atlas_app for SELECT beyond
-- what the relay needs.

-- ============================================================================
-- Vector and search indexes
-- ============================================================================

-- HNSW for episodic recall. Cosine distance matches the embedding model's
-- similarity metric; the dimension must stay in step with EMBEDDING_DIMENSIONS
-- and the vector(1024) column (a schema test asserts the latter).
CREATE INDEX IF NOT EXISTS episodes_embedding_hnsw
  ON episodes USING hnsw (embedding vector_cosine_ops);

-- Trigram search over transaction descriptions, for "that transfer to Musa".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);
