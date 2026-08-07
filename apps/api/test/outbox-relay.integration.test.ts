import { PrismaClient } from '@prisma/client';
import { idFromSeed, type DomainEvent, type UserId } from '@atlas/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { DomainEventBus, type DomainEventHandler } from '../src/shared/events/domain-event-bus';
import { BASE_RETRY_DELAY_MS } from '../src/shared/events/outbox-backoff';
import { OutboxRelay } from '../src/shared/events/outbox-relay.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';

/**
 * The durable relay, against a real outbox.
 *
 * Before this existed, a process dying between the producing commit and the in-process
 * dispatch left an event undelivered forever — a user's transaction that simply never
 * appeared. These tests are about that hole being closed, and about the relay failing
 * safely: rescheduling with backoff, giving up loudly rather than silently, and never
 * letting two instances deliver the same row.
 *
 * Requires `pnpm infra:up` and an applied migration.
 */

const TEST_EVENT = 'test.relay_probe';

const userId = idFromSeed<'UserId'>(15_000) as UserId;

const env = parseEnv();

const owner = new PrismaClient({
  datasources: { db: { url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL } },
});

const app = new PrismaService(env);

/** Records what it received, and can be told to fail. */
class ProbeHandler implements DomainEventHandler {
  readonly eventType = TEST_EVENT;
  readonly received: string[] = [];
  shouldFail = false;

  async handle(event: DomainEvent): Promise<void> {
    this.received.push(event.id);
    if (this.shouldFail) throw new Error('probe handler refused');
  }
}

let handler: ProbeHandler;
let relay: OutboxRelay;

let seed = 0;

async function queueEvent(overrides: { occurredAt?: Date; attempts?: number } = {}) {
  seed += 1;
  const id = idFromSeed<'EventId'>(15_100 + seed);

  await owner.outboxEvent.create({
    data: {
      id,
      type: TEST_EVENT,
      aggregateType: 'Probe',
      aggregateId: `probe-${seed}`,
      userId,
      payload: { seed },
      schemaVersion: 1,
      occurredAt: overrides.occurredAt ?? new Date(),
      attempts: overrides.attempts ?? 0,
    },
  });

  return id;
}

function row(id: string) {
  return owner.outboxEvent.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  await owner.outboxEvent.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
  await owner.user.create({
    data: { id: userId, phoneE164: '+2348000015000', timezone: 'Africa/Lagos' },
  });
});

beforeEach(async () => {
  await owner.outboxEvent.deleteMany({ where: { userId } });

  handler = new ProbeHandler();
  const bus = new DomainEventBus();
  bus.register(handler);
  relay = new OutboxRelay(app, bus, env);
});

afterAll(async () => {
  await owner.outboxEvent.deleteMany({ where: { userId } });
  await owner.user.deleteMany({ where: { id: userId } });
  await owner.$disconnect();
  await app.$disconnect();
});

describe('draining the backlog', () => {
  it('delivers an undelivered event and marks it published', async () => {
    const id = await queueEvent();

    const outcome = await relay.drainOnce();

    expect(outcome).toEqual({ delivered: 1, failed: 0 });
    expect(handler.received).toEqual([id]);
    expect((await row(id)).publishedAt).not.toBeNull();
  });

  /** The whole point: a row left behind by a crashed process is picked up later. */
  it('picks up a row that an earlier process never dispatched', async () => {
    const stranded = await queueEvent({ occurredAt: new Date(Date.now() - 60 * 60 * 1_000) });

    await relay.drainOnce();

    expect(handler.received).toEqual([stranded]);
  });

  it('does nothing when the backlog is empty', async () => {
    expect(await relay.drainOnce()).toEqual({ delivered: 0, failed: 0 });
    expect(handler.received).toEqual([]);
  });

  it('never re-delivers a published row', async () => {
    await queueEvent();

    await relay.drainOnce();
    await relay.drainOnce();

    expect(handler.received).toHaveLength(1);
  });

  it('delivers oldest first', async () => {
    const older = await queueEvent({ occurredAt: new Date('2026-08-01T00:00:00Z') });
    const newer = await queueEvent({ occurredAt: new Date('2026-08-02T00:00:00Z') });

    await relay.drainOnce();

    expect(handler.received).toEqual([older, newer]);
  });
});

describe('failing safely', () => {
  it('reschedules a failed event with backoff and records why', async () => {
    const id = await queueEvent();
    handler.shouldFail = true;

    const outcome = await relay.drainOnce();

    expect(outcome).toEqual({ delivered: 0, failed: 1 });

    const after = await row(id);
    expect(after.publishedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('probe handler refused');
    expect(after.nextAttemptAt).not.toBeNull();
    // First failure waits the base delay, so it is not eligible again immediately.
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + BASE_RETRY_DELAY_MS / 2);
  });

  it('does not retry before the backoff has elapsed', async () => {
    await queueEvent();
    handler.shouldFail = true;
    await relay.drainOnce();

    handler.shouldFail = false;
    const second = await relay.drainOnce();

    expect(second).toEqual({ delivered: 0, failed: 0 });
    expect(handler.received).toHaveLength(1);
  });

  it('retries once the backoff has elapsed, and succeeds', async () => {
    const id = await queueEvent();
    handler.shouldFail = true;
    await relay.drainOnce();

    // Rather than sleeping: bring the schedule forward, which is what waiting would do.
    await owner.outboxEvent.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    handler.shouldFail = false;
    expect(await relay.drainOnce()).toEqual({ delivered: 1, failed: 0 });
    expect((await row(id)).publishedAt).not.toBeNull();
  });

  it('clears the recorded error once delivery succeeds', async () => {
    const id = await queueEvent();
    handler.shouldFail = true;
    await relay.drainOnce();
    await owner.outboxEvent.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    handler.shouldFail = false;
    await relay.drainOnce();

    const after = await row(id);
    expect(after.lastError).toBeNull();
    expect(after.nextAttemptAt).toBeNull();
  });

  it('counts the attempt even when dispatch never completes', async () => {
    // Claim increments attempts, so a process that dies mid-dispatch still spends budget.
    // Otherwise an event that reliably crashes the process would be retried forever.
    const id = await queueEvent({ attempts: 4 });

    await relay.drainOnce();

    expect((await row(id)).attempts).toBe(5);
  });

  /**
   * Dead-lettering is driven from the attempt count rather than from a failure handler,
   * precisely so it also covers an event that kills the process before any handler runs.
   */
  it('dead-letters an event that has used its whole budget', async () => {
    const id = await queueEvent({ attempts: 12 });

    await relay.drainOnce();

    const after = await row(id);
    expect(after.deadLetteredAt).not.toBeNull();
    expect(after.publishedAt).toBeNull();
    expect(handler.received).toEqual([]);
  });

  it('keeps a dead-lettered row rather than deleting the evidence', async () => {
    const id = await queueEvent({ attempts: 12 });

    await relay.drainOnce();
    await relay.drainOnce();

    // Still there, still undelivered, and no longer being attempted.
    expect(await row(id)).toBeTruthy();
    expect(handler.received).toEqual([]);
  });

  it('lets one poisonous event through without stalling the rest', async () => {
    const poison = await queueEvent({ attempts: 12 });
    const healthy = await queueEvent();

    await relay.drainOnce();

    expect(handler.received).toEqual([healthy]);
    expect((await row(poison)).deadLetteredAt).not.toBeNull();
    expect((await row(healthy)).publishedAt).not.toBeNull();
  });
});

describe('two instances', () => {
  /**
   * `FOR UPDATE SKIP LOCKED` is what makes horizontal scaling safe. Without it both
   * instances would claim the same rows and every event would be delivered twice on every
   * tick — survivable, since handlers are idempotent, but pure waste.
   */
  it('never hand the same event to both relays', async () => {
    const ids = [await queueEvent(), await queueEvent(), await queueEvent()];

    const secondHandler = new ProbeHandler();
    const secondBus = new DomainEventBus();
    secondBus.register(secondHandler);
    const secondRelay = new OutboxRelay(app, secondBus, env);

    await Promise.all([relay.drainOnce(), secondRelay.drainOnce()]);

    const seen = [...handler.received, ...secondHandler.received];

    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('leases a claimed row so a second relay skips it', async () => {
    const id = await queueEvent();

    // Simulates a claim whose dispatch is still in flight.
    await owner.outboxEvent.update({
      where: { id },
      data: { attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000) },
    });

    expect(await relay.drainOnce()).toEqual({ delivered: 0, failed: 0 });
    expect(handler.received).toEqual([]);
  });
});

describe('pruning', () => {
  it('deletes delivered rows past the retention window', async () => {
    const old = await queueEvent();
    await owner.outboxEvent.update({
      where: { id: old },
      data: { publishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000) },
    });

    expect(await relay.pruneDelivered()).toBe(1);
    expect(await owner.outboxEvent.count({ where: { id: old } })).toBe(0);
  });

  it('keeps recently delivered rows', async () => {
    const recent = await queueEvent();
    await relay.drainOnce();

    expect(await relay.pruneDelivered()).toBe(0);
    expect(await owner.outboxEvent.count({ where: { id: recent } })).toBe(1);
  });

  /** An undelivered event is the backlog. Pruning it would lose the state change. */
  it('never deletes an undelivered row, however old', async () => {
    const ancient = await queueEvent({
      occurredAt: new Date('2020-01-01T00:00:00Z'),
    });

    expect(await relay.pruneDelivered()).toBe(0);
    expect(await owner.outboxEvent.count({ where: { id: ancient } })).toBe(1);
  });

  it('never deletes a dead-lettered row — it is the evidence', async () => {
    const dead = await queueEvent({ attempts: 12 });
    await relay.drainOnce();

    expect(await relay.pruneDelivered()).toBe(0);
    expect(await owner.outboxEvent.count({ where: { id: dead } })).toBe(1);
  });
});
