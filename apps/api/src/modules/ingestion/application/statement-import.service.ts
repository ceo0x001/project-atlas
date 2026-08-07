import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type AccountId,
  type CurrencyCode,
  type InstitutionId,
  Money,
  newId,
  type ObservationId,
  type UserId,
} from '@atlas/shared-kernel';
import { TRANSACTION_OBSERVED, type TransactionObservedEvent } from '@shared/events/contracts';
import { DomainEventBus } from '@shared/events/domain-event-bus';
import { OutboxWriter } from '@shared/events/outbox';
import { TenantScope, type TenantClient } from '@shared/prisma/tenant-scope';
import { describeCsvFailure, parseCsvStatement } from '../domain/statement/csv-statement';
import {
  applyReconciliationGate,
  describeRejection,
} from '../domain/statement/reconciliation-gate';
import type { StatementRow } from '../domain/statement/statement-row';
import { statementRowDedupeKey } from '../domain/parsing/dedupe-key';

/**
 * Imports a bank statement.
 *
 * ## All or nothing
 *
 * The import is refused unless the statement's own arithmetic closes (ARCHITECTURE §6.3). A
 * partial import is the one outcome that must never happen: it produces a total wrong by
 * exactly the rows nobody noticed, and the user has no way to tell. So parsing and validation
 * both complete before a single observation is written, and a rejected import writes none.
 *
 * ## Why this is not a Temporal workflow
 *
 * ADR-007 expected statement import to be the process that earned Temporal, and on inspection
 * it does not. There is nothing to compensate — a rejected import has written nothing, so
 * there is no partial state to unwind. There is no timer, and no human wait measured in days:
 * rejection is a status on a row, not a suspended execution. And a re-run is idempotent by
 * construction, because every row carries a `statementRowDedupeKey`, so the recovery story for
 * a crash is "upload it again".
 *
 * What the process does need is a visible state machine, which `statement_imports` already is.
 * Adding a workflow engine would put a second durable record of the same progress beside that
 * row, able to disagree with it.
 *
 * ## The document is not retained
 *
 * No object store is wired up, so the file is parsed and discarded and `objectKey` records
 * only a hash of its contents. That is a real limitation — an import cannot be re-parsed later
 * if the parser improves — and also a deliberate one for now: retaining bank statements means
 * deciding about encryption at rest and NDPR retention, and holding fewer copies of someone's
 * financial history is the safer default until those decisions are made.
 */

export interface ImportStatementInput {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly institutionId: InstitutionId | null;
  readonly filename: string;
  readonly content: string;
  readonly currency: CurrencyCode;
  /**
   * The statement's own printed opening and closing figures, when the person uploading can see
   * them. Optional, but supplying them strengthens the check materially: it is the only way to
   * catch the first row's direction being read backwards, and the only way to verify a layout
   * that prints no running balance at all.
   */
  readonly statedOpeningMinor?: bigint | undefined;
  readonly statedClosingMinor?: bigint | undefined;
}

export type ImportOutcome =
  | {
      readonly status: 'COMPLETED';
      readonly importId: string;
      readonly rowCount: number;
      readonly observationCount: number;
      readonly openingBalanceMinor: bigint | null;
      readonly closingBalanceMinor: bigint | null;
      readonly verifiedBy: 'balance-chain' | 'endpoints';
    }
  | {
      readonly status: 'REJECTED' | 'FAILED';
      readonly importId: string;
      readonly reason: string;
    };

@Injectable()
export class StatementImportService {
  private readonly logger = new Logger(StatementImportService.name);

  constructor(
    private readonly tenantScope: TenantScope,
    private readonly outbox: OutboxWriter,
    private readonly bus: DomainEventBus,
  ) {}

  async import(input: ImportStatementInput): Promise<ImportOutcome> {
    const importId = newId<'FactId'>();
    const objectKey = `sha256:${createHash('sha256').update(input.content, 'utf8').digest('hex')}`;

    await this.recordImport(input, importId, objectKey);

    const parsed = parseCsvStatement(input.content, input.currency);

    if (!parsed.ok) {
      // FAILED rather than REJECTED: the file could not be read at all, which is a different
      // fact from a file that was read and did not add up. The user's next action differs too.
      const reason = describeCsvFailure(parsed.error);
      await this.markTerminal(input.userId, importId, 'FAILED', reason);

      return { status: 'FAILED', importId, reason };
    }

    const gate = applyReconciliationGate(parsed.value.rows, input.currency, {
      opening: this.moneyOrNull(input.statedOpeningMinor, input.currency),
      closing: this.moneyOrNull(input.statedClosingMinor, input.currency),
    });

    if (!gate.ok) {
      const reason = describeRejection(gate.rejection);

      this.logger.warn(`Statement import ${importId} rejected: ${reason}`);
      await this.markTerminal(input.userId, importId, 'REJECTED', reason, {
        rowCount: parsed.value.rows.length,
      });

      return { status: 'REJECTED', importId, reason };
    }

    const events = await this.admitRows(input, importId, parsed.value.rows);

    await this.markCompleted(input.userId, importId, {
      rowCount: parsed.value.rows.length,
      observationCount: events.length,
      openingBalanceMinor: gate.value.openingBalance?.minor ?? null,
      closingBalanceMinor: gate.value.closingBalance?.minor ?? null,
    });

    // Dispatched after the import is marked complete, so a handler that fails cannot leave the
    // import looking unfinished. The outbox rows are already durable, and the relay retries
    // anything this pass does not deliver.
    await this.dispatch(events);

    this.logger.log(
      `Statement import ${importId}: ${events.length} of ${parsed.value.rows.length} rows admitted ` +
        `(verified by ${gate.value.method})`,
    );

    return {
      status: 'COMPLETED',
      importId,
      rowCount: parsed.value.rows.length,
      observationCount: events.length,
      openingBalanceMinor: gate.value.openingBalance?.minor ?? null,
      closingBalanceMinor: gate.value.closingBalance?.minor ?? null,
      verifiedBy: gate.value.method,
    };
  }

  /**
   * Writes the rows as observations and their events, in one transaction.
   *
   * Rows become observations rather than transactions, which is the whole reason M2's work
   * pays off here: the same statement uploaded twice is deduplicated by
   * `statementRowDedupeKey`, and a row describing a purchase already known from an SMS alert
   * is *reconciled into it* rather than double-counted. Nothing in this file has to know that.
   */
  private async admitRows(
    input: ImportStatementInput,
    importId: string,
    rows: readonly StatementRow[],
  ): Promise<readonly TransactionObservedEvent[]> {
    return this.tenantScope.run(input.userId, async (tx) => {
      const occurrences = new Map<string, number>();
      const events: TransactionObservedEvent[] = [];

      for (const row of rows) {
        const observationId = newId<'ObservationId'>();

        // Two genuine identical rows on the same day are indistinguishable without an ordinal,
        // and silently collapsing them would understate spending. Counted per distinct shape so
        // the key stays stable across re-uploads of the same file.
        const shape = `${row.occurredAt.toISOString()}|${row.amount.minor}|${row.direction}|${row.description}`;
        const occurrenceIndex = occurrences.get(shape) ?? 0;
        occurrences.set(shape, occurrenceIndex + 1);

        const dedupeKey = statementRowDedupeKey({
          accountLast4: null,
          occurredAt: row.occurredAt,
          amountMinor: row.amount.minor,
          currency: row.amount.currency,
          direction: row.direction,
          description: row.description,
          reference: row.reference,
          occurrenceIndex,
        });

        const created = await this.createObservation(tx, {
          observationId,
          importId,
          input,
          row,
          dedupeKey,
        });

        // Already imported. Skipped silently rather than reported as an error: re-uploading a
        // statement that overlaps one already imported is the normal way people use this.
        if (!created) continue;

        events.push(this.buildEvent(input, observationId, row));
      }

      await this.outbox.append(tx, events);

      return events;
    });
  }

  /** Returns false when the row was already imported, which the unique key enforces. */
  private async createObservation(
    tx: TenantClient,
    args: {
      observationId: ObservationId;
      importId: string;
      input: ImportStatementInput;
      row: StatementRow;
      dedupeKey: string;
    },
  ): Promise<boolean> {
    const { row, input } = args;

    const result = await tx.transactionObservation.createMany({
      data: [
        {
          id: args.observationId,
          userId: input.userId,
          accountId: input.accountId,
          institutionId: input.institutionId,
          statementImportId: args.importId,
          source: 'STATEMENT',
          amountMinor: row.amount.minor,
          currency: row.amount.currency,
          direction: row.direction,
          occurredAt: row.occurredAt,
          observedAt: new Date(),
          balanceAfterMinor: row.balanceAfter?.minor ?? null,
          description: row.description.length === 0 ? null : row.description,
          rawReference: row.reference,
          dedupeKey: args.dedupeKey,
        },
      ],
      skipDuplicates: true,
    });

    return result.count > 0;
  }

  private buildEvent(
    input: ImportStatementInput,
    observationId: ObservationId,
    row: StatementRow,
  ): TransactionObservedEvent {
    return {
      id: newId<'EventId'>(),
      type: TRANSACTION_OBSERVED,
      aggregateType: 'TransactionObservation',
      aggregateId: observationId,
      userId: input.userId,
      occurredAt: new Date(),
      schemaVersion: 1,
      payload: {
        observationId,
        source: 'STATEMENT',
        accountId: input.accountId,
        institutionId: input.institutionId,
        deviceId: null,
        amountMinor: row.amount.minor.toString(),
        currency: row.amount.currency,
        direction: row.direction,
        occurredAt: row.occurredAt.toISOString(),
        balanceAfterMinor: row.balanceAfter?.minor.toString() ?? null,
        description: row.description.length === 0 ? null : row.description,
      },
    };
  }

  private async dispatch(events: readonly TransactionObservedEvent[]): Promise<void> {
    if (events.length === 0) return;

    const outcome = await this.bus.dispatch(events);
    await this.outbox.markPublished(outcome.published);

    for (const failure of outcome.failed) {
      await this.outbox.recordFailure(failure.eventId, failure.reason);
    }
  }

  private async recordImport(
    input: ImportStatementInput,
    importId: string,
    objectKey: string,
  ): Promise<void> {
    await this.tenantScope.run(input.userId, (tx) =>
      tx.statementImport.create({
        data: {
          id: importId,
          userId: input.userId,
          accountId: input.accountId,
          objectKey,
          filename: input.filename,
          mimeType: 'text/csv',
          byteSize: Buffer.byteLength(input.content, 'utf8'),
          status: 'PARSING',
        },
      }),
    );
  }

  private async markTerminal(
    userId: UserId,
    importId: string,
    status: 'FAILED' | 'REJECTED',
    reason: string,
    extra: { rowCount?: number } = {},
  ): Promise<void> {
    await this.tenantScope.run(userId, (tx) =>
      tx.statementImport.update({
        where: { id: importId },
        data: {
          status,
          failureReason: reason,
          completedAt: new Date(),
          reconciled: false,
          ...(extra.rowCount === undefined ? {} : { rowCount: extra.rowCount }),
        },
      }),
    );
  }

  private async markCompleted(
    userId: UserId,
    importId: string,
    totals: {
      rowCount: number;
      observationCount: number;
      openingBalanceMinor: bigint | null;
      closingBalanceMinor: bigint | null;
    },
  ): Promise<void> {
    await this.tenantScope.run(userId, (tx) =>
      tx.statementImport.update({
        where: { id: importId },
        data: {
          status: 'COMPLETED',
          // Only ever set on an import that passed the gate, so it means "the statement's own
          // arithmetic closed" rather than "we finished processing".
          reconciled: true,
          completedAt: new Date(),
          ...totals,
        },
      }),
    );
  }

  private moneyOrNull(minor: bigint | undefined, currency: CurrencyCode): Money | null {
    return minor === undefined ? null : Money.of(minor, currency);
  }
}
