import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { idFromSeed, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/config/env';
import { DeviceEnrolmentService } from '../src/modules/identity';
import { REPRESENTATIVE_SHAPES } from '../src/modules/ingestion/domain/parsing/__fixtures__/bank-shapes';
import { smsDedupeKey } from '../src/modules/ingestion/domain/parsing/dedupe-key';
import { parseMessage } from '../src/modules/ingestion/domain/parsing/template-engine';
import {
  LAGOS_UTC_OFFSET_MINUTES,
  type ParseContext,
} from '../src/modules/ingestion/domain/parsing/transforms';
import { LEDGER_QUERY_PORT } from '../src/modules/ledger';
import type { LedgerQueryPort } from '../src/modules/ledger';

/**
 * The M1 milestone, end to end.
 *
 * Real bank-alert text goes through the on-device parser, is posted over HTTP to the
 * authenticated sync endpoint, becomes an observation, is admitted by the ledger via
 * a domain event, and finally comes back as a truthful spending total.
 *
 * Nothing here is mocked: real Postgres, real row-level security, real HTTP.
 */

const owner = new PrismaClient({
  datasources: { db: { url: parseEnv().DATABASE_MIGRATION_URL ?? parseEnv().DATABASE_URL } },
});

const lagos: ParseContext = {
  utcOffsetMinutes: LAGOS_UTC_OFFSET_MINUTES,
  defaultCurrency: 'NGN',
};

const ingestUser = idFromSeed<'UserId'>(7_000) as UserId;
const clientOnlyUser = idFromSeed<'UserId'>(7_100) as UserId;

let app: INestApplication;
let baseUrl: string;
let ingestToken: string;
let clientOnlyToken: string;
let ledger: LedgerQueryPort;

/** Turns a parsed SMS into exactly the payload a device would post. */
function observationFrom(shapeIndex: number, fixtureIndex: number, receivedAt: Date) {
  const shape = REPRESENTATIVE_SHAPES[shapeIndex]!;
  const body = shape.fixtures[fixtureIndex]!.input;
  const senderId = `SENDER-${shapeIndex}`;

  const parsed = parseMessage({ senderId, body, receivedAt }, [shape.template], lagos);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error.detail}`);

  const transaction = parsed.value;

  return {
    id: idFromSeed<'ObservationId'>(8_000 + shapeIndex * 10 + fixtureIndex),
    source: 'SMS' as const,
    dedupeKey: smsDedupeKey({ senderId, body, receivedAt }),
    amountMinor: transaction.amount.minor.toString(),
    currency: transaction.currency,
    direction: transaction.direction,
    occurredAt: transaction.occurredAt.toISOString(),
    observedAt: receivedAt.toISOString(),
    balanceAfterMinor: transaction.balanceAfter?.minor.toString() ?? null,
    description: transaction.description,
    accountLast4: transaction.accountLast4,
    institutionId: shape.template.institutionId,
    templateId: shape.template.id,
  };
}

async function postObservations(
  token: string | null,
  observations: unknown[],
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/v1/sync/observations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ observations }),
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

async function wipe(): Promise<void> {
  const users = [ingestUser, clientOnlyUser];
  await owner.outboxEvent.deleteMany({ where: { userId: { in: users } } });
  await owner.transactionObservation.deleteMany({ where: { userId: { in: users } } });
  await owner.transaction.deleteMany({ where: { userId: { in: users } } });
  await owner.deviceCredential.deleteMany({ where: { userId: { in: users } } });
  await owner.device.deleteMany({ where: { userId: { in: users } } });
  await owner.account.deleteMany({ where: { userId: { in: users } } });
  await owner.user.deleteMany({ where: { id: { in: users } } });
  await owner.parseTemplate.deleteMany({
    where: { id: { in: REPRESENTATIVE_SHAPES.map((shape) => shape.template.id) } },
  });
  await owner.institution.deleteMany({
    where: { id: { in: REPRESENTATIVE_SHAPES.map((shape) => shape.template.institutionId) } },
  });
}

beforeAll(async () => {
  await wipe();

  await owner.user.createMany({
    data: [
      { id: ingestUser, phoneE164: '+2348000007000', timezone: 'Africa/Lagos' },
      { id: clientOnlyUser, phoneE164: '+2348000007100', timezone: 'Africa/Lagos' },
    ],
  });

  // The banks whose templates matched. Observations reference them, so they must
  // exist — a real device only reports an institution the server published to it.
  await owner.institution.createMany({
    data: REPRESENTATIVE_SHAPES.map((shape, index) => ({
      id: shape.template.institutionId,
      name: `Shape ${index} Bank`,
      shortName: `Shape${index}`,
      smsSenderIds: [`SENDER-${index}`],
    })),
  });

  // The published templates the device parsed with. Observations reference them so
  // parse quality can be attributed per template, and the foreign key makes an
  // observation citing a template nobody published impossible.
  await owner.parseTemplate.createMany({
    data: REPRESENTATIVE_SHAPES.map((shape) => ({
      id: shape.template.id,
      institutionId: shape.template.institutionId,
      channel: shape.template.channel,
      version: shape.template.version,
      name: shape.template.name,
      matchPattern: shape.template.matchPattern,
      fieldMap: shape.template.fields as never,
      fixtures: shape.fixtures as never,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    })),
  });

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  ledger = app.get<LedgerQueryPort>(LEDGER_QUERY_PORT);
  const enrolment = app.get(DeviceEnrolmentService);

  ingestToken = (
    await enrolment.enrol({
      userId: ingestUser,
      platform: 'ANDROID',
      role: 'CLIENT_AND_INGESTION_NODE',
      model: 'Tecno Spark',
    })
  ).token;

  clientOnlyToken = (
    await enrolment.enrol({ userId: clientOnlyUser, platform: 'IOS', role: 'CLIENT' })
  ).token;
});

afterAll(async () => {
  await app?.close();
  await wipe();
  await owner.$disconnect();
});

describe('authentication', () => {
  it('refuses a request with no token', async () => {
    expect((await postObservations(null, [])).status).toBe(401);
  });

  it('refuses an unknown token', async () => {
    expect((await postObservations('not-a-real-token', [])).status).toBe(401);
  });

  it('refuses a revoked credential', async () => {
    const enrolment = app.get(DeviceEnrolmentService);
    const throwaway = await enrolment.enrol({
      userId: ingestUser,
      platform: 'ANDROID',
      role: 'INGESTION_NODE',
    });

    const observation = observationFrom(0, 0, new Date('2026-08-07T13:24:00Z'));
    expect((await postObservations(throwaway.token, [observation])).status).toBe(200);

    await enrolment.revokeCredential(ingestUser, throwaway.deviceId);

    expect((await postObservations(throwaway.token, [observation])).status).toBe(401);

    // Clean up so it does not pollute the totals asserted below. The outbox row
    // must go too — it is durable by design and would otherwise be counted later.
    await owner.transactionObservation.deleteMany({ where: { userId: ingestUser } });
    await owner.transaction.deleteMany({ where: { userId: ingestUser } });
    await owner.outboxEvent.deleteMany({ where: { userId: ingestUser } });
  });
});

describe('request validation', () => {
  it('rejects a malformed observation with per-field detail', async () => {
    const { status, body } = await postObservations(ingestToken, [
      { id: 'not-a-ulid', source: 'SMS', amountMinor: '-5' },
    ]);

    expect(status).toBe(400);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('rejects an empty batch', async () => {
    expect((await postObservations(ingestToken, [])).status).toBe(400);
  });

  it('rejects a signed amount — direction carries the sign, never the amount', async () => {
    const observation = observationFrom(0, 0, new Date('2026-08-07T13:24:00Z'));

    const { status } = await postObservations(ingestToken, [
      { ...observation, amountMinor: '-500000' },
    ]);

    expect(status).toBe(400);
  });
});

describe('device role enforcement', () => {
  it('refuses SMS observations from a device that cannot observe SMS', async () => {
    // An iOS client has no SMS access (ADR-006), so a claim of SMS provenance from
    // one is either a bug or an attempt to inject readings.
    const observation = observationFrom(0, 0, new Date('2026-08-07T13:24:00Z'));

    const { status, body } = await postObservations(clientOnlyToken, [observation]);

    expect(status).toBe(200);
    expect(body.results[0].status).toBe('REJECTED');
    expect(body.results[0].reason).toContain('CLIENT');
    expect(body.accepted).toBe(0);
  });
});

describe('the full pipeline: SMS text to a truthful total', () => {
  const receivedAt = new Date('2026-08-07T13:24:00Z');

  beforeAll(async () => {
    const observations = [
      observationFrom(0, 0, receivedAt), // 5,000.00 DEBIT, 7 Aug, Shape0 ••1234
      observationFrom(0, 1, new Date('2026-07-25T09:06:00Z')), // 250,000.00 CREDIT, 25 Jul
      observationFrom(1, 0, receivedAt), // 5,000.00 DEBIT, 7 Aug, Shape1 ••1234
      observationFrom(2, 0, receivedAt), // 2,500.00 DEBIT, 7 Aug, no account hint
    ];

    const { status, body } = await postObservations(ingestToken, observations);

    expect(status).toBe(200);
    expect(body.accepted).toBe(4);
  });

  it('answers "how much did I spend in August" from parsed bank alerts', async () => {
    const result = await ledger.aggregate({
      userId: ingestUser,
      timezone: 'Africa/Lagos',
      metrics: ['total', 'count'],
      filter: {
        currency: 'NGN',
        direction: 'DEBIT',
        occurredFrom: new Date('2026-08-01T00:00:00Z'),
        occurredTo: new Date('2026-08-31T23:59:59Z'),
      },
    });

    // 5,000.00 + 5,000.00 + 2,500.00 — the July salary credit is correctly excluded.
    expect(result.rows[0]!.total.toDecimalString()).toBe('12500.00');
    expect(result.rows[0]!.count).toBe(3);
  });

  it('creates one canonical transaction per observation and links them', async () => {
    const observations = await owner.transactionObservation.findMany({
      where: { userId: ingestUser },
      select: { id: true, transactionId: true },
    });

    expect(observations).toHaveLength(4);
    // Invariant I6: every transaction can name the observation it came from.
    expect(observations.every((row) => row.transactionId !== null)).toBe(true);

    expect(await owner.transaction.count({ where: { userId: ingestUser } })).toBe(4);
  });

  it('discovers accounts from the alerts themselves', async () => {
    const accounts = await owner.account.findMany({
      where: { userId: ingestUser },
      select: { label: true },
      orderBy: { label: 'asc' },
    });

    // Four accounts discovered from four alerts, with no user input at all:
    // two different accounts at the same bank (the current account and the one the
    // salary landed in), one at a second bank, and one alert that named only its
    // bank — so that label falls back to the bank rather than to something anonymous.
    expect(accounts.map((account) => account.label)).toEqual([
      'Shape0 ••1234',
      'Shape0 ••9876',
      'Shape1 ••1234',
      'Shape2',
    ]);
  });

  it('adopts the balance the bank reported', async () => {
    const account = await owner.account.findFirst({
      where: { userId: ingestUser, label: 'Shape0 ••1234' },
      select: { currentBalanceMinor: true, balanceAsOf: true },
    });

    // Two alerts hit this account: 7 August (balance 45,200.15) and 25 July
    // (295,200.15). The older one must not win, however late it arrives.
    expect(account!.currentBalanceMinor).toBe(4_520_015n);
    expect(account!.balanceAsOf?.toISOString()).toBe('2026-08-07T13:23:45.000Z');
  });

  it('marks the outbox events published once admitted', async () => {
    const events = await owner.outboxEvent.findMany({
      where: { userId: ingestUser },
      select: { type: true, publishedAt: true, attempts: true, lastError: true },
    });

    expect(events).toHaveLength(4);
    expect(events.every((event) => event.type === 'ingestion.transaction_observed')).toBe(true);
    expect(events.every((event) => event.publishedAt !== null)).toBe(true);
    expect(events.every((event) => event.lastError === null)).toBe(true);
  });

  it('is idempotent — replaying the batch changes nothing', async () => {
    const replay = [
      observationFrom(0, 0, receivedAt),
      observationFrom(0, 1, new Date('2026-07-25T09:06:00Z')),
      observationFrom(1, 0, receivedAt),
      observationFrom(2, 0, receivedAt),
    ];

    const { status, body } = await postObservations(ingestToken, replay);

    expect(status).toBe(200);
    expect(body.duplicates).toBe(4);
    expect(body.accepted).toBe(0);

    // The books are unchanged: no double counting.
    expect(await owner.transaction.count({ where: { userId: ingestUser } })).toBe(4);
  });

  it('catches a batch that repeats a dedupe key within itself', async () => {
    const one = observationFrom(0, 0, new Date('2026-09-01T10:00:00Z'));
    const duplicate = { ...one, id: idFromSeed<'ObservationId'>(9_999) };

    const { body } = await postObservations(ingestToken, [one, duplicate]);

    expect(body.results[0].status).toBe('ACCEPTED');
    expect(body.results[1].status).toBe('DUPLICATE');
    expect(body.results[1].reason).toContain('same batch');
  });
});

describe('tenant isolation across the pipeline', () => {
  it('writes only into the account of the authenticated device', async () => {
    // clientOnlyUser's device was refused above, so that user must have no ledger.
    expect(await owner.transaction.count({ where: { userId: clientOnlyUser } })).toBe(0);
    expect(await owner.account.count({ where: { userId: clientOnlyUser } })).toBe(0);
  });
});
