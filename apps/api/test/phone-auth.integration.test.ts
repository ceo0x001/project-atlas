import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/config/env';
import {
  hashOtpCode,
  MAX_CHALLENGES_PER_PHONE,
  MAX_OTP_ATTEMPTS,
} from '../src/modules/identity/domain/otp';

/**
 * Phone sign-in over real HTTP.
 *
 * This is the only unauthenticated surface in the application and the one that mints
 * credentials, so most of what follows is about abuse rather than the happy path: brute
 * force, replay, enumeration, and the ceiling on how many codes one number can request.
 *
 * The code is read out of the database rather than intercepted from the sender. That is
 * deliberate — it proves the code the server will actually accept is the one it stored, which
 * a mocked sender could not tell us.
 *
 * Real Postgres, real row-level security, real HTTP. Requires `pnpm infra:up`.
 */

const env = parseEnv();

const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

let app: INestApplication;
let baseUrl: string;

const PHONE = '08031110001';
const PHONE_E164 = '+2348031110001';
const OTHER_PHONE_E164 = '+2348031110002';

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json().catch(() => null)) as never };
}

/** Starts a sign-in and returns the challenge plus the code the server stored. */
async function startAndReadCode(phone = PHONE) {
  const started = await post('/v1/auth/start', { phone });
  const challengeId = started.body.challengeId as string;

  // Codes are hashed, so the plaintext is recovered by matching against the stored hash —
  // the same thing an attacker would have to do, and cheap for six digits.
  const row = await owner.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });

  let code: string | null = null;
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const padded = String(candidate).padStart(6, '0');
    if (hashOtpCode(padded) === row.codeHash) {
      code = padded;
      break;
    }
  }

  return { challengeId, code, started };
}

function verifyBody(challengeId: string, code: string, overrides: Record<string, unknown> = {}) {
  return {
    challengeId,
    code,
    platform: 'ANDROID',
    role: 'CLIENT_AND_INGESTION_NODE',
    model: 'Pixel 8a',
    ...overrides,
  };
}

async function wipe(): Promise<void> {
  const phones = [PHONE_E164, OTHER_PHONE_E164];

  await owner.authChallenge.deleteMany({ where: { phoneE164: { in: phones } } });

  const users = await owner.user.findMany({
    where: { phoneE164: { in: phones } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await owner.deviceCredential.deleteMany({ where: { userId: { in: ids } } });
    await owner.device.deleteMany({ where: { userId: { in: ids } } });
    // Deleting the user cascades to its phone mapping. Leaving one behind pointed the next
    // sign-in at a user that no longer existed — which is how the missing foreign key was
    // found in the first place.
    await owner.user.deleteMany({ where: { id: { in: ids } } });
  }

  await owner.phoneIdentity.deleteMany({ where: { phoneE164: { in: phones } } });
}

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await app.close();
  await owner.$disconnect();
});

describe('signing in for the first time', () => {
  it('creates the user, enrols the device and returns a token once', async () => {
    const { challengeId, code } = await startAndReadCode();
    expect(code).not.toBeNull();

    const verified = await post('/v1/auth/verify', verifyBody(challengeId, code!));

    expect(verified.status).toBe(200);
    expect(verified.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verified.body.userId).toHaveLength(26);
    expect(verified.body.deviceId).toHaveLength(26);

    const created = await owner.user.findUniqueOrThrow({ where: { phoneE164: PHONE_E164 } });
    expect(created.id).toBe(verified.body.userId);
    expect(created.timezone).toBe('Africa/Lagos');
  });

  it('stores only the token hash, never the token', async () => {
    const { challengeId, code } = await startAndReadCode();
    const verified = await post('/v1/auth/verify', verifyBody(challengeId, code!));

    const credential = await owner.deviceCredential.findUniqueOrThrow({
      where: { deviceId: verified.body.deviceId as string },
    });

    expect(credential.tokenHash).not.toBe(verified.body.token);
    expect(credential.tokenHash).toHaveLength(64);
  });

  /** The token has to actually work, or enrolment is theatre. */
  it('issues a token the sync endpoint accepts', async () => {
    const { challengeId, code } = await startAndReadCode();
    const verified = await post('/v1/auth/verify', verifyBody(challengeId, code!));

    const capabilities = await fetch(`${baseUrl}/v1/sync/capabilities`, {
      method: 'POST',
      headers: { authorization: `Bearer ${verified.body.token as string}` },
    });

    expect(capabilities.status).toBe(200);
  });

  it('signs an existing user in again rather than duplicating them', async () => {
    const first = await startAndReadCode();
    const firstVerified = await post('/v1/auth/verify', verifyBody(first.challengeId, first.code!));

    const second = await startAndReadCode();
    const secondVerified = await post(
      '/v1/auth/verify',
      verifyBody(second.challengeId, second.code!),
    );

    expect(secondVerified.body.userId).toBe(firstVerified.body.userId);
    expect(secondVerified.body.deviceId).not.toBe(firstVerified.body.deviceId);
    expect(await owner.user.count({ where: { phoneE164: PHONE_E164 } })).toBe(1);
  });

  it.each([
    ['08031110001', '+2348031110001'],
    ['+2348031110001', '+2348031110001'],
    ['2348031110001', '+2348031110001'],
  ])('treats %s as the same identity', async (spelling, expected) => {
    const { challengeId, code } = await startAndReadCode(spelling);
    await post('/v1/auth/verify', verifyBody(challengeId, code!));

    expect(await owner.user.count({ where: { phoneE164: expected } })).toBe(1);
  });
});

describe('refusing bad input', () => {
  it.each([
    ['a non-Nigerian number', '+14155552671'],
    ['too few digits', '0801234'],
    ['letters', 'not-a-number'],
  ])('refuses %s at the edge', async (_label, phone) => {
    expect((await post('/v1/auth/start', { phone })).status).toBe(400);
  });

  it('refuses a code that is not six digits without spending an attempt', async () => {
    const { challengeId } = await startAndReadCode();

    expect((await post('/v1/auth/verify', verifyBody(challengeId, '12345'))).status).toBe(400);

    const row = await owner.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.attempts).toBe(0);
  });

  /** ADR-006: iOS cannot read SMS, so it must not be enrolled as a device that can. */
  it('refuses to enrol an iOS device as an ingestion node', async () => {
    const { challengeId, code } = await startAndReadCode();

    const refused = await post(
      '/v1/auth/verify',
      verifyBody(challengeId, code!, { platform: 'IOS', role: 'INGESTION_NODE' }),
    );

    expect(refused.status).toBe(400);
  });

  it('allows an iOS device as a plain client', async () => {
    const { challengeId, code } = await startAndReadCode();

    const allowed = await post(
      '/v1/auth/verify',
      verifyBody(challengeId, code!, { platform: 'IOS', role: 'CLIENT' }),
    );

    expect(allowed.status).toBe(200);
  });
});

describe('resisting abuse', () => {
  it('rejects a wrong code and counts the attempt', async () => {
    const { challengeId, code } = await startAndReadCode();
    const wrong = code === '000000' ? '111111' : '000000';

    expect((await post('/v1/auth/verify', verifyBody(challengeId, wrong))).status).toBe(401);

    const row = await owner.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.attempts).toBe(1);
  });

  /**
   * The attempt cap is what makes a six-digit secret defensible. Without it, a million
   * guesses is minutes of work.
   */
  it('kills the challenge after five wrong guesses, even if the right code follows', async () => {
    const { challengeId, code } = await startAndReadCode();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < MAX_OTP_ATTEMPTS; attempt += 1) {
      expect((await post('/v1/auth/verify', verifyBody(challengeId, wrong))).status).toBe(401);
    }

    // The correct code, submitted after the cap, must not work.
    expect((await post('/v1/auth/verify', verifyBody(challengeId, code!))).status).toBe(401);
    expect(await owner.user.count({ where: { phoneE164: PHONE_E164 } })).toBe(0);
  });

  it('is single use: a correct code cannot enrol a second device', async () => {
    const { challengeId, code } = await startAndReadCode();

    expect((await post('/v1/auth/verify', verifyBody(challengeId, code!))).status).toBe(200);
    expect((await post('/v1/auth/verify', verifyBody(challengeId, code!))).status).toBe(401);

    expect(await owner.device.count()).toBeGreaterThan(0);
    const user = await owner.user.findUniqueOrThrow({ where: { phoneE164: PHONE_E164 } });
    expect(await owner.device.count({ where: { userId: user.id } })).toBe(1);
  });

  it('rejects an expired challenge', async () => {
    const { challengeId, code } = await startAndReadCode();

    await owner.authChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect((await post('/v1/auth/verify', verifyBody(challengeId, code!))).status).toBe(401);
  });

  it('rejects an unknown challenge id', async () => {
    const unknown = 'Z'.repeat(26);

    expect((await post('/v1/auth/verify', verifyBody(unknown, '123456'))).status).toBe(401);
  });

  /**
   * A throttled request still looks like a success and still returns a challenge id — it
   * simply carries a code that matches nothing. Refusing visibly would let an attacker probe
   * where the ceiling is.
   */
  it('stops sending usable codes once a number has requested too many', async () => {
    for (let i = 0; i < MAX_CHALLENGES_PER_PHONE; i += 1) {
      expect((await post('/v1/auth/start', { phone: PHONE })).status).toBe(200);
    }

    const throttled = await startAndReadCode();

    expect(throttled.started.status).toBe(200);
    expect(throttled.started.body.challengeId).toHaveLength(26);
    // No six-digit code hashes to what was stored, so the challenge can never be completed.
    expect(throttled.code).toBeNull();
  });

  /**
   * Enumeration: `start` must answer identically for a registered and an unregistered
   * number, or anyone can discover who uses Atlas by trying numbers.
   */
  it('answers identically for a registered and an unregistered number', async () => {
    const first = await startAndReadCode();
    await post('/v1/auth/verify', verifyBody(first.challengeId, first.code!));

    const registered = await post('/v1/auth/start', { phone: PHONE });
    const unregistered = await post('/v1/auth/start', { phone: '08031110002' });

    expect(registered.status).toBe(unregistered.status);
    expect(Object.keys(registered.body).sort()).toEqual(Object.keys(unregistered.body).sort());
  });

  /**
   * Every rejection is the same 401 with the same body. Distinguishing them would tell an
   * attacker which of the three limits they had hit, and therefore which to work around.
   */
  it('gives the same response for every kind of rejection', async () => {
    const wrongCode = await startAndReadCode();
    const wrong = wrongCode.code === '000000' ? '111111' : '000000';
    const wrongResponse = await post('/v1/auth/verify', verifyBody(wrongCode.challengeId, wrong));

    const expired = await startAndReadCode();
    await owner.authChallenge.update({
      where: { id: expired.challengeId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expiredResponse = await post(
      '/v1/auth/verify',
      verifyBody(expired.challengeId, expired.code!),
    );

    const unknownResponse = await post('/v1/auth/verify', verifyBody('Z'.repeat(26), '123456'));

    expect(wrongResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
    expect(wrongResponse.body.message).toBe(expiredResponse.body.message);
    expect(wrongResponse.body.message).toBe(unknownResponse.body.message);
  });

  it('never returns the code in the start response', async () => {
    const started = await post('/v1/auth/start', { phone: PHONE });

    expect(JSON.stringify(started.body)).not.toMatch(/\d{6}/);
    expect(Object.keys(started.body).sort()).toEqual(['challengeId', 'expiresAt']);
  });
});
