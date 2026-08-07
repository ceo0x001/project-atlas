import { Injectable, Logger } from '@nestjs/common';
import {
  type AccountId,
  type DomainEvent,
  type InstitutionId,
  newId,
  type ObservationId,
  type UserId,
} from '@atlas/shared-kernel';
import { canIngest, type DevicePrincipal } from '@modules/identity';
import { TRANSACTION_OBSERVED, type TransactionObservedPayload } from '@shared/events/contracts';
import { DomainEventBus } from '@shared/events/domain-event-bus';
import { OutboxWriter } from '@shared/events/outbox';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import type { IntakeResult, ObservationInput, SyncObservationsResponse } from '../api/sync.dto';

/**
 * Accepts observations from a device and records them.
 *
 * This service never writes to the ledger (ARCHITECTURE §4). It records what a
 * source *claimed* and emits `TransactionObserved`; the ledger decides what becomes
 * a canonical transaction. Keeping admission on the other side of an event means
 * ingestion stays a dumb, testable pipeline and there is exactly one place where a
 * transaction can enter the books.
 */
@Injectable()
export class ObservationIntakeService {
  private readonly logger = new Logger(ObservationIntakeService.name);

  constructor(
    private readonly tenantScope: TenantScope,
    private readonly outbox: OutboxWriter,
    private readonly eventBus: DomainEventBus,
  ) {}

  async ingest(
    principal: DevicePrincipal,
    inputs: readonly ObservationInput[],
  ): Promise<SyncObservationsResponse> {
    const results = new Map<string, IntakeResult>();
    const admissible: ObservationInput[] = [];
    const seenInBatch = new Set<string>();

    for (const input of inputs) {
      // A device that is not an ingestion node cannot claim SMS provenance. Without
      // this an iOS client could assert readings it has no way to have observed
      // (ADR-006), and the ledger would trust them.
      if ((input.source === 'SMS' || input.source === 'EMAIL') && !canIngest(principal.role)) {
        results.set(input.id, {
          id: input.id,
          status: 'REJECTED',
          reason: `device role ${principal.role} may not submit ${input.source} observations`,
        });
        continue;
      }

      // Duplicate keys inside one batch are a client defect. Surfacing it beats
      // letting the unique constraint decide which one silently won.
      if (seenInBatch.has(input.dedupeKey)) {
        results.set(input.id, {
          id: input.id,
          status: 'DUPLICATE',
          reason: 'dedupeKey repeated within the same batch',
        });
        continue;
      }

      seenInBatch.add(input.dedupeKey);
      admissible.push(input);
    }

    const events = await this.tenantScope.run(principal.userId, async (tx) => {
      const alreadyStored = await tx.transactionObservation.findMany({
        where: { dedupeKey: { in: admissible.map((input) => input.dedupeKey) } },
        select: { dedupeKey: true },
      });
      const storedKeys = new Set(alreadyStored.map((row) => row.dedupeKey));

      const fresh = admissible.filter((input) => {
        if (!storedKeys.has(input.dedupeKey)) return true;
        results.set(input.id, { id: input.id, status: 'DUPLICATE' });
        return false;
      });

      if (fresh.length === 0) return [];

      const accountResolver = new AccountResolver(tx, principal.userId);
      const pending: { input: ObservationInput; accountId: AccountId }[] = [];

      for (const input of fresh) {
        const accountId = await accountResolver.resolve(
          (input.institutionId ?? null) as InstitutionId | null,
          input.accountLast4 ?? null,
        );
        pending.push({ input, accountId });
      }

      await tx.transactionObservation.createMany({
        data: pending.map(({ input, accountId }) => ({
          id: input.id,
          userId: principal.userId,
          accountId,
          deviceId: principal.deviceId,
          institutionId: input.institutionId ?? null,
          source: input.source,
          amountMinor: BigInt(input.amountMinor),
          currency: input.currency,
          direction: input.direction,
          occurredAt: new Date(input.occurredAt),
          observedAt: new Date(input.observedAt),
          balanceAfterMinor:
            input.balanceAfterMinor == null ? null : BigInt(input.balanceAfterMinor),
          description: input.description ?? null,
          rawReference: input.rawReference ?? null,
          dedupeKey: input.dedupeKey,
          parsedByTemplateId: input.templateId ?? null,
        })),
        // Belt and braces: the unique constraint on (userId, dedupeKey) is the real
        // guarantee, and it also covers two devices racing the same message.
        skipDuplicates: true,
      });

      const emitted = pending.map(({ input, accountId }) =>
        this.buildEvent(principal, input, accountId),
      );

      await this.outbox.append(tx, emitted);

      for (const { input } of pending) {
        results.set(input.id, { id: input.id, status: 'ACCEPTED' });
      }

      return emitted;
    });

    await this.publish(events);

    return this.summarise(inputs, results);
  }

  private buildEvent(
    principal: DevicePrincipal,
    input: ObservationInput,
    accountId: AccountId,
  ): DomainEvent<typeof TRANSACTION_OBSERVED, TransactionObservedPayload> {
    return {
      id: newId<'EventId'>(),
      type: TRANSACTION_OBSERVED,
      aggregateType: 'TransactionObservation',
      aggregateId: input.id,
      userId: principal.userId,
      occurredAt: new Date(),
      schemaVersion: 1,
      payload: {
        observationId: input.id as ObservationId,
        source: input.source,
        accountId,
        institutionId: (input.institutionId ?? null) as InstitutionId | null,
        deviceId: principal.deviceId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        direction: input.direction,
        occurredAt: input.occurredAt,
        balanceAfterMinor: input.balanceAfterMinor ?? null,
        description: input.description ?? null,
      },
    };
  }

  /**
   * Dispatches after the transaction commits, then reconciles the outbox.
   *
   * Observations are already durable at this point, so a handler failure loses
   * nothing: the outbox row stays unpublished and carries its error. The durable
   * relay that retries the backlog lands in M2 on Temporal, which is why a failure
   * is logged rather than silently queued.
   */
  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    const outcome = await this.eventBus.dispatch(events);

    await this.outbox.markPublished(outcome.published);

    for (const failure of outcome.failed) {
      await this.outbox.recordFailure(failure.eventId, failure.reason);
      this.logger.warn(
        `Observation recorded but admission deferred (${failure.eventId}): ${failure.reason}`,
      );
    }
  }

  private summarise(
    inputs: readonly ObservationInput[],
    results: Map<string, IntakeResult>,
  ): SyncObservationsResponse {
    const ordered = inputs.map(
      (input) =>
        results.get(input.id) ?? {
          id: input.id,
          status: 'REJECTED' as const,
          reason: 'not processed',
        },
    );

    return {
      results: ordered,
      accepted: ordered.filter((result) => result.status === 'ACCEPTED').length,
      duplicates: ordered.filter((result) => result.status === 'DUPLICATE').length,
      rejected: ordered.filter((result) => result.status === 'REJECTED').length,
    };
  }
}

/**
 * Maps an observation's account hints onto a real account, creating one when the
 * bank is seen for the first time.
 *
 * Auto-creation is deliberate: Atlas discovers accounts from alerts rather than
 * asking the user to enumerate them, which is most of why first-run feels like magic.
 * Resolutions are cached per batch so a hundred alerts from one bank do not each
 * issue a lookup.
 */
class AccountResolver {
  private readonly cache = new Map<string, AccountId>();

  constructor(
    private readonly tx: TenantClient,
    private readonly userId: UserId,
  ) {}

  async resolve(institutionId: InstitutionId | null, last4: string | null): Promise<AccountId> {
    const cacheKey = `${institutionId ?? '-'}|${last4 ?? '-'}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const existing = await this.tx.account.findFirst({
      where: { institutionId, accountNumberLast4: last4 },
      select: { id: true },
    });

    if (existing) {
      const id = existing.id as AccountId;
      this.cache.set(cacheKey, id);
      return id;
    }

    const institution = institutionId
      ? await this.tx.institution.findUnique({
          where: { id: institutionId },
          select: { shortName: true },
        })
      : null;

    const created = await this.tx.account.create({
      data: {
        id: newId<'AccountId'>(),
        userId: this.userId,
        institutionId,
        accountNumberLast4: last4,
        label: this.labelFor(institution?.shortName ?? null, last4),
        // Unknown until the user confirms; CURRENT is the commonest default and is
        // corrected in the UI rather than guessed at from an alert.
        type: 'CURRENT',
        currency: 'NGN',
      },
      select: { id: true },
    });

    const id = created.id as AccountId;
    this.cache.set(cacheKey, id);
    return id;
  }

  private labelFor(institutionName: string | null, last4: string | null): string {
    if (institutionName && last4) return `${institutionName} ••${last4}`;
    if (institutionName) return institutionName;
    if (last4) return `Account ••${last4}`;

    // An alert we could attribute to money but not to an account. Still real money,
    // so it gets a home the user can rename or merge later.
    return 'Unlinked account';
  }
}
