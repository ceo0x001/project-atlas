import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { UserId } from '@atlas/shared-kernel';
import { PrismaService } from './prisma.service';

/** A Prisma client bound to an open transaction with tenant scoping applied. */
export type TenantClient = Prisma.TransactionClient;

/**
 * Runs database work inside a transaction scoped to exactly one user.
 *
 * Postgres row-level security decides visibility from `atlas.user_id`
 * (see prisma/sql/001_row_level_security.sql). That setting is transaction-local, so
 * every read and write must happen inside one of these blocks.
 *
 * Two design notes worth keeping in mind:
 *
 * **Why `set_config` and not `SET LOCAL`.** `SET LOCAL` cannot take a bind
 * parameter, which would force the user id to be interpolated into SQL — precisely
 * the thing this codebase refuses to do anywhere. `set_config(name, value, true)` is
 * an ordinary function call, so the id travels as a parameter and the `true` keeps
 * it scoped to the transaction.
 *
 * **Forgetting this wrapper fails closed.** A query issued outside a tenant scope
 * finds `atlas.user_id` unset, matches no policy, and returns zero rows. A missing
 * scope therefore surfaces as "no data" during development rather than as a
 * cross-tenant leak in production — the failure mode we can afford.
 *
 * The cost is a BEGIN/COMMIT around every read. That is a real latency tax, and it
 * is the right trade: the alternative is pinning a session variable to a pooled
 * connection, where one leaked connection means one user reading another's finances.
 */
@Injectable()
export class TenantScope {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(userId: UserId, work: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('atlas.user_id', ${userId}, true)`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
}
