import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainEvent, EventId, UserId } from '@atlas/shared-kernel';
import { ENV, type Env } from '@config/env';
import { PrismaService } from '@shared/prisma/prisma.service';
import { DomainEventBus } from './domain-event-bus';
import { nextAttemptAt } from './outbox-backoff';

/**
 * Drains the transactional outbox.
 *
 * The writer already guarantees that "the state changed" and "an event was recorded"
 * commit together (ADR-002). What was missing is anything that retries: a process dying
 * between commit and the in-process dispatch left the row undelivered forever, so a user's
 * transaction would simply never appear. This is what closes that hole.
 *
 * ## Not a Temporal workflow, on purpose
 *
 * ADR-007 anticipated putting this on Temporal. It is the wrong tool here. The outbox
 * table *is* the durable state — a workflow would be a second durable store for the same
 * fact, able to disagree with the row it describes. And a relay is high-frequency
 * infrastructure: one workflow per event means workflow history and timers per SMS alert,
 * which does not survive scale. Temporal remains right for statement import, where the work
 * is genuinely long-running and multi-step.
 *
 * ## Claim by lease, not by holding a lock
 *
 * The obvious implementation keeps the claiming transaction open while handlers run. That
 * would hold row locks for the duration of handler work, and handlers open their own
 * tenant-scoped transactions — a good way to exhaust the pool or deadlock.
 *
 * Instead a short transaction stamps `nextAttemptAt = now + lease` on the claimed rows and
 * commits. Another instance will not touch them until the lease expires, and dispatch
 * happens with no locks held. If this process dies mid-dispatch the lease lapses and
 * someone else retries — at-least-once preserved, which the handlers already require.
 *
 * `attempts` is incremented **at claim time** rather than on failure. A crash during
 * dispatch would otherwise never count against the budget, so an event that reliably kills
 * the process would be retried forever.
 *
 * ## Duplicate delivery is expected
 *
 * The fast path still dispatches in-process immediately after commit, because waiting a
 * poll interval would add latency to every alert. The relay is the safety net, not the
 * primary route, so an event can be delivered twice. Handlers are idempotent — admission
 * returns early once an observation has a transaction — which is what makes this safe.
 */

/** How long a claimed row stays invisible to other relay instances. */
const LEASE_MS = 60_000;

/** Rows claimed per tick. Caps both blast radius and how long one tick can take. */
const BATCH_SIZE = 20;

/**
 * Attempts before giving up. Deliberately generous: the cost of retrying a transient
 * failure is small, and the cost of dead-lettering a real transaction is a number missing
 * from someone's ledger.
 */
const MAX_ATTEMPTS = 12;

const POLL_INTERVAL_MS = 1_000;

/** Delivered rows older than this are pruned. The outbox is a queue, not an archive. */
const RETENTION_DAYS = 7;

/** Prune every N ticks rather than every tick — it is housekeeping, not the job. */
const PRUNE_EVERY_TICKS = 300;

interface ClaimedRow {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly userId: string;
  readonly payload: unknown;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly attempts: number;
}

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    // Not started under test: a relay polling in the background races the integration
    // suite's own fixtures and makes failures depend on timing. Tests drive `drainOnce`
    // directly instead, which is also the only way to assert what one tick did.
    if (this.env.NODE_ENV === 'test') return;

    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);

    // Without this the interval keeps the event loop alive and the process will not exit.
    this.timer.unref();

    this.logger.log(`Outbox relay polling every ${POLL_INTERVAL_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // Ticks must not overlap. A slow batch would otherwise stack up behind itself and
    // multiply the work in flight rather than draining it.
    if (this.running) return;
    this.running = true;

    try {
      await this.drainOnce();

      this.ticks += 1;
      if (this.ticks % PRUNE_EVERY_TICKS === 0) await this.pruneDelivered();
    } catch (error) {
      // A failure here is the relay itself breaking, not one event failing. Swallowed so
      // the loop survives to try again — the backlog is durable, so nothing is lost.
      this.logger.error(`Outbox relay tick failed: ${describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Claims one batch, dispatches it, and records the outcome.
   *
   * Returns how many rows were delivered and how many failed, so a caller — or a test —
   * can tell an empty backlog from a stuck one.
   */
  async drainOnce(): Promise<{ delivered: number; failed: number }> {
    await this.deadLetterExhausted();

    const claimed = await this.claim();
    if (claimed.length === 0) return { delivered: 0, failed: 0 };

    const outcome = await this.bus.dispatch(claimed.map(toDomainEvent));

    if (outcome.published.length > 0) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: { in: [...outcome.published] } },
        data: { publishedAt: new Date(), nextAttemptAt: null, lastError: null },
      });
    }

    const now = new Date();
    const attemptsById = new Map(claimed.map((row) => [row.id, row.attempts]));

    for (const failure of outcome.failed) {
      const attempts = attemptsById.get(failure.eventId) ?? 1;

      await this.prisma.outboxEvent.update({
        where: { id: failure.eventId },
        data: {
          nextAttemptAt: nextAttemptAt(now, attempts),
          lastError: failure.reason.slice(0, 1_000),
        },
      });
    }

    if (outcome.failed.length > 0) {
      this.logger.warn(
        `Outbox: ${outcome.published.length} delivered, ${outcome.failed.length} failed and rescheduled`,
      );
    }

    return { delivered: outcome.published.length, failed: outcome.failed.length };
  }

  /**
   * Claims a batch by leasing it.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes running several API instances safe: each takes a
   * disjoint set of rows instead of contending for the same ones. Raw SQL because Prisma
   * cannot express it, and the alternative — read then write and hope — is exactly the race
   * this clause exists to remove.
   *
   * Ordered by `occurredAt` so delivery is roughly causal. Only roughly: concurrent
   * instances and retries can reorder, which is safe here because handlers are idempotent
   * and the balance anchor is guarded on `balanceAsOf` rather than assuming arrival order.
   */
  private async claim(): Promise<readonly ClaimedRow[]> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);

    return this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      WITH claimed AS (
        SELECT id
        FROM outbox_events
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND attempts < ${MAX_ATTEMPTS}
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
        ORDER BY "occurredAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events AS e
      SET attempts = e.attempts + 1,
          "nextAttemptAt" = ${leaseUntil}
      FROM claimed
      WHERE e.id = claimed.id
      RETURNING e.id, e.type, e."aggregateType", e."aggregateId", e."userId",
                e.payload, e."schemaVersion", e."occurredAt", e.attempts
    `);
  }

  /**
   * Marks rows that have used their whole attempt budget.
   *
   * Driven from the attempt count rather than from a failure handler, because an event that
   * crashes the process never reaches a failure handler — that is the case dead-lettering
   * most needs to cover.
   */
  private async deadLetterExhausted(): Promise<void> {
    const exhausted = await this.prisma.outboxEvent.updateMany({
      where: {
        publishedAt: null,
        deadLetteredAt: null,
        attempts: { gte: MAX_ATTEMPTS },
      },
      data: { deadLetteredAt: new Date() },
    });

    if (exhausted.count > 0) {
      // Loud on purpose. A dead-lettered event is a state change the rest of the system
      // never heard about, which for this product means money missing from a ledger.
      this.logger.error(
        `Outbox: ${exhausted.count} event(s) dead-lettered after ${MAX_ATTEMPTS} attempts and need attention`,
      );
    }
  }

  /**
   * Deletes delivered rows past the retention window. Never touches undelivered ones.
   *
   * Public so it is directly testable and so an operator can run it on demand — housekeeping
   * that only ever happens on a timer is housekeeping nobody can verify.
   */
  async pruneDelivered(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);

    const removed = await this.prisma.outboxEvent.deleteMany({
      where: { publishedAt: { not: null, lt: cutoff } },
    });

    if (removed.count > 0) this.logger.log(`Outbox: pruned ${removed.count} delivered event(s)`);

    return removed.count;
  }
}

function toDomainEvent(row: ClaimedRow): DomainEvent {
  return {
    id: row.id as EventId,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    userId: row.userId as UserId,
    payload: row.payload as never,
    schemaVersion: row.schemaVersion,
    occurredAt: row.occurredAt,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
