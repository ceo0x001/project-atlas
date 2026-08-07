import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { parseEnv } from '../src/config/env';
import { DeviceEnrolmentService } from '../src/modules/identity';

/**
 * Statement import over real HTTP.
 *
 * Two things are being proved. The first is the gate: a statement whose arithmetic does not
 * close imports **nothing**, and says which line broke and by how much.
 *
 * The second is why statement rows go in as observations rather than transactions. A row
 * describing a purchase Atlas already knows about from an SMS alert must reconcile *into* that
 * transaction rather than beside it — so the backfill does not double someone's spending. That
 * behaviour is entirely M2's, and this is where it pays off.
 *
 * Requires `pnpm infra:up`.
 */

const env = parseEnv();

const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const userId = idFromSeed<'UserId'>(17_000) as UserId;
const accountId = idFromSeed<'AccountId'>(17_100);

let app: INestApplication;
let baseUrl: string;
let token: string;

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json().catch(() => null)) as never };
}

function importCsv(content: string, extra: Record<string, unknown> = {}) {
  return post('/v1/statements/import', {
    accountId,
    filename: 'statement.csv',
    currency: 'NGN',
    content,
    ...extra,
  });
}

/** 10,000 opening → 2,000 debit → 500 credit → 8,500. Internally consistent. */
const CONSISTENT_CSV = [
  'Date,Narration,Debit,Credit,Balance',
  '01/08/2026,POS PURCHASE SHOPRITE,2000.00,,8000.00',
  '02/08/2026,SALARY AUGUST,,500.00,8500.00',
].join('\n');

async function liveTransactions() {
  return owner.transaction.findMany({
    where: { userId, supersededByTransactionId: null },
    orderBy: { occurredAt: 'asc' },
    include: { observations: { select: { source: true } } },
  });
}

async function wipe(): Promise<void> {
  await owner.transactionObservation.deleteMany({ where: { userId } });
  await owner.statementImport.deleteMany({ where: { userId } });
  await owner.suspectedDuplicate.deleteMany({ where: { userId } });
  await owner.reconciliationEvent.deleteMany({ where: { userId } });
  await owner.outboxEvent.deleteMany({ where: { userId } });
  await owner.transaction.updateMany({
    where: { userId },
    data: { supersededByTransactionId: null },
  });
  await owner.transaction.deleteMany({ where: { userId } });
}

beforeAll(async () => {
  await wipe();
  await owner.deviceCredential.deleteMany({ where: { userId } });
  await owner.device.deleteMany({ where: { userId } });
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });

  await owner.user.create({
    data: { id: userId, phoneE164: '+2348000017000', timezone: 'Africa/Lagos' },
  });
  await owner.account.create({
    data: { id: accountId, userId, label: 'Current', type: 'CURRENT', currency: 'NGN' },
  });

  // Configured exactly as `main.ts` does, so the body-size behaviour under test is the one
  // that ships rather than Express's default.
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const enrolment = app.get(DeviceEnrolmentService);
  const enrolled = await enrolment.enrol({ userId, platform: 'ANDROID', role: 'CLIENT' });
  token = enrolled.token;
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await owner.deviceCredential.deleteMany({ where: { userId } });
  await owner.device.deleteMany({ where: { userId } });
  await owner.account.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
  await app.close();
  await owner.$disconnect();
});

describe('importing a statement that reconciles', () => {
  it('imports every row and reports how it was verified', async () => {
    const result = await importCsv(CONSISTENT_CSV);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'COMPLETED',
      rowCount: 2,
      observationCount: 2,
      verifiedBy: 'balance-chain',
    });

    // Opening is implied by the first row rather than printed: 8,000 + 2,000.
    expect(result.body.openingBalanceMinor).toBe('1000000');
    expect(result.body.closingBalanceMinor).toBe('850000');
  });

  it('produces transactions with the right amounts and directions', async () => {
    await importCsv(CONSISTENT_CSV);

    const live = await liveTransactions();

    expect(live).toHaveLength(2);
    expect(live[0]?.amountMinor).toBe(200_000n);
    expect(live[0]?.direction).toBe('DEBIT');
    expect(live[0]?.description).toBe('POS PURCHASE SHOPRITE');
    expect(live[1]?.direction).toBe('CREDIT');
  });

  it('marks the import reconciled, meaning the statement’s own arithmetic closed', async () => {
    const result = await importCsv(CONSISTENT_CSV);

    const record = await owner.statementImport.findUniqueOrThrow({
      where: { id: result.body.importId as string },
    });

    expect(record.status).toBe('COMPLETED');
    expect(record.reconciled).toBe(true);
    expect(record.observationCount).toBe(2);
  });

  /** Re-uploading an overlapping statement is how people actually use this. */
  it('is idempotent: the same file twice imports nothing the second time', async () => {
    await importCsv(CONSISTENT_CSV);
    const second = await importCsv(CONSISTENT_CSV);

    expect(second.body).toMatchObject({ status: 'COMPLETED', rowCount: 2, observationCount: 0 });
    expect(await liveTransactions()).toHaveLength(2);
  });

  it('does not retain the uploaded document, only a hash of it', async () => {
    const result = await importCsv(CONSISTENT_CSV);

    const record = await owner.statementImport.findUniqueOrThrow({
      where: { id: result.body.importId as string },
    });

    expect(record.objectKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.objectKey).not.toContain('SHOPRITE');
  });
});

describe('the gate refuses rather than importing partially', () => {
  /**
   * The failure the whole feature is built around. A row is missing from the file, so the
   * running balance does not add up — and importing the rest would understate spending by
   * exactly the missing amount, invisibly.
   */
  it('imports nothing when the running balance does not add up', async () => {
    const broken = [
      'Date,Narration,Debit,Credit,Balance',
      '01/08/2026,POS PURCHASE,2000.00,,8000.00',
      // A 1,200 debit belongs here and is absent from the file.
      '03/08/2026,SALARY,,500.00,7300.00',
    ].join('\n');

    const result = await importCsv(broken);

    expect(result.body.status).toBe('REJECTED');
    expect(result.body.reason).toContain('line 3');
    expect(result.body.reason).toContain('nothing has been imported');

    // The claim in that message has to be true.
    expect(await liveTransactions()).toEqual([]);
    expect(await owner.transactionObservation.count({ where: { userId } })).toBe(0);
  });

  it('records the rejection so it can be read back later', async () => {
    const broken = [
      'Date,Narration,Debit,Credit,Balance',
      '01/08/2026,A,2000.00,,8000.00',
      '02/08/2026,B,,500.00,9999.00',
    ].join('\n');

    const result = await importCsv(broken);

    const record = await owner.statementImport.findUniqueOrThrow({
      where: { id: result.body.importId as string },
    });

    expect(record.status).toBe('REJECTED');
    expect(record.reconciled).toBe(false);
    expect(record.failureReason).toContain('running balance');
  });

  it('refuses a statement whose totals cannot be checked at all', async () => {
    const noBalances = ['Date,Narration,Amount', '01/08/2026,POS PURCHASE,-2000.00'].join('\n');

    const result = await importCsv(noBalances);

    expect(result.body.status).toBe('REJECTED');
    expect(result.body.reason).toContain('cannot be checked');
    expect(await liveTransactions()).toEqual([]);
  });

  it('accepts the same unverifiable file once its stated balances are supplied', async () => {
    const noBalances = ['Date,Narration,Amount', '01/08/2026,POS PURCHASE,-2000.00'].join('\n');

    const result = await importCsv(noBalances, {
      statedOpeningMinor: '1000000',
      statedClosingMinor: '800000',
    });

    expect(result.body).toMatchObject({ status: 'COMPLETED', verifiedBy: 'endpoints' });
  });

  it('reports an unreadable file as FAILED, which is a different problem', async () => {
    const unreadable = ['Narration,Amount', 'POS PURCHASE,-2000.00'].join('\n');

    const result = await importCsv(unreadable);

    expect(result.body.status).toBe('FAILED');
    expect(result.body.reason).toContain('date');
  });

  /**
   * Two limits, in order: the body parser refuses anything past the configured ceiling with a
   * 413 before the request is ever parsed, and the schema refuses anything past
   * `MAX_STATEMENT_BYTES` with a 400. The outer one firing first is the right layering — the
   * cheapest rejection happens earliest.
   */
  it('refuses an oversized file before parsing it', async () => {
    const huge = `Date,Amount\n${'2026-08-01,-1.00\n'.repeat(300_000)}`;

    expect((await importCsv(huge)).status).toBe(413);
  });

  it('refuses a file past the schema limit but inside the body limit', async () => {
    // Just over MAX_STATEMENT_BYTES (1 MiB) of content, which JSON-escapes to roughly 1.1 MiB
    // of body — inside the parser's ceiling, so the schema is what refuses it.
    const overSchema = `Date,Amount\n${'2026-08-01,-1.00\n'.repeat(62_000)}`;

    expect((await importCsv(overSchema)).status).toBe(400);
  });
});

describe('reconciling against what the SMS feed already saw', () => {
  /**
   * The reason statement rows are observations rather than transactions. Atlas already knows
   * about this purchase from an alert; the statement row is a second sighting of the same money,
   * so it must attach to the existing transaction rather than create a new one.
   */
  it('collapses a statement row into the transaction an SMS alert already created', async () => {
    // The alert: same amount, same day, and the same balance afterwards, which is what
    // identifies it.
    await owner.transactionObservation.create({
      data: {
        id: idFromSeed<'ObservationId'>(17_200),
        userId,
        accountId,
        source: 'SMS',
        amountMinor: 200_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-01T14:30:00Z'),
        observedAt: new Date('2026-08-01T14:30:05Z'),
        balanceAfterMinor: 800_000n,
        description: 'POS PURCHASE AT SHOPRITE IKEJA',
        dedupeKey: `${'0'.repeat(63)}1`,
      },
    });

    const transactionId = idFromSeed<'TransactionId'>(17_300);
    await owner.transaction.create({
      data: {
        id: transactionId,
        userId,
        accountId,
        amountMinor: 200_000n,
        currency: 'NGN',
        direction: 'DEBIT',
        occurredAt: new Date('2026-08-01T14:30:00Z'),
        description: 'POS PURCHASE AT SHOPRITE IKEJA',
        balanceAfterMinor: 800_000n,
        status: 'POSTED',
      },
    });
    await owner.transactionObservation.update({
      where: { id: idFromSeed<'ObservationId'>(17_200) },
      data: { transactionId },
    });

    const result = await importCsv(CONSISTENT_CSV);
    expect(result.body.status).toBe('COMPLETED');

    const live = await liveTransactions();

    // Two transactions, not three: the statement's first row joined the alert's transaction.
    expect(live).toHaveLength(2);

    const shoprite = live.find((row) => row.id === transactionId);
    expect(shoprite?.observations.map((o) => o.source).sort()).toEqual(['SMS', 'STATEMENT']);

    // The alert's narration survives, because alerts outrank statements on description.
    expect(shoprite?.description).toBe('POS PURCHASE AT SHOPRITE IKEJA');
  });
});

describe('reading back past imports', () => {
  it('lists them newest first with their outcome', async () => {
    await importCsv(CONSISTENT_CSV);

    const response = await fetch(`${baseUrl}/v1/statements`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { imports: { status: string; reconciled: boolean }[] };

    expect(response.status).toBe(200);
    expect(body.imports[0]).toMatchObject({ status: 'COMPLETED', reconciled: true });
  });

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/v1/statements`);

    expect(response.status).toBe(401);
  });
});
