import {
  type CurrencyCode,
  err,
  type Money,
  ok,
  type Result,
  type TemplateId,
} from '@atlas/shared-kernel';
import type { ParseTemplate, TemplateField, TemplateFieldKind } from '../parse-template';
import {
  MAX_MESSAGE_LENGTH,
  type ParseContext,
  parseAccountLast4,
  parseAmount,
  parseCurrency,
  parseDateTime,
  parseDirection,
  type TransactionDirection,
} from './transforms';

/**
 * The deterministic SMS/email parser (ADR-004).
 *
 * Claude authors candidate templates offline; this engine is what actually runs,
 * and it does nothing clever. Given a message and a set of candidate templates it
 * either produces an exact transaction or an explained failure — it never guesses,
 * because a guessed amount is indistinguishable from a fabricated one once it
 * reaches the ledger.
 */

export interface SourceMessage {
  readonly senderId: string;
  readonly body: string;
  /** Timestamp assigned by the OS/provider. Stable across re-reads of the inbox. */
  readonly receivedAt: Date;
}

export interface ParsedTransaction {
  readonly amount: Money;
  readonly currency: CurrencyCode;
  readonly direction: TransactionDirection;
  readonly occurredAt: Date;
  readonly balanceAfter: Money | null;
  readonly description: string | null;
  readonly accountLast4: string | null;
  readonly templateId: TemplateId;
  readonly templateVersion: number;
}

export type ParseFailureCode =
  'MESSAGE_TOO_LONG' | 'NO_TEMPLATE_MATCHED' | 'FIELD_EXTRACTION_FAILED';

export interface ParseFailure {
  readonly code: ParseFailureCode;
  readonly detail: string;
  /**
   * Set when a template's pattern matched but its fields did not extract. That
   * distinction matters: it is a defect in a published template, not an unknown
   * message format, and it should page someone rather than quietly queue for
   * template synthesis.
   */
  readonly attemptedTemplateId?: TemplateId;
}

/**
 * Compiled patterns are cached by template identity. Templates are immutable once
 * published (a change is a new version), so the cache never needs invalidating.
 */
const compiledPatterns = new Map<string, RegExp>();

function compilePattern(template: ParseTemplate): RegExp {
  const cacheKey = `${template.id}@${template.version}`;
  const cached = compiledPatterns.get(cacheKey);
  if (cached) return cached;

  // 'i' because banks are inconsistent about casing; 's' so '.' spans the newlines
  // in multi-line alerts.
  const compiled = new RegExp(template.matchPattern, 'is');
  compiledPatterns.set(cacheKey, compiled);
  return compiled;
}

/** Exposed for tests and for reloading templates in long-lived workers. */
export function clearPatternCache(): void {
  compiledPatterns.clear();
}

function rawValueFor(
  field: TemplateField,
  groups: Record<string, string | undefined>,
): Result<string, string> {
  if (field.literal !== undefined) return ok(field.literal);
  if (field.group === undefined) return err(`field '${field.kind}' has neither group nor literal`);

  const captured = groups[field.group];
  if (captured === undefined) {
    return err(`group '${field.group}' for field '${field.kind}' did not capture`);
  }

  return ok(captured);
}

interface ExtractedFields {
  amount?: Money;
  currency?: CurrencyCode;
  direction?: TransactionDirection;
  occurredAt?: Date;
  balanceAfter?: Money;
  description?: string;
  accountLast4?: string;
}

/**
 * Applies every field transform. Currency is resolved first because the amount and
 * balance transforms need it to know how many minor units a major unit holds.
 */
function extractFields(
  template: ParseTemplate,
  groups: Record<string, string | undefined>,
  context: ParseContext,
): Result<ExtractedFields, string[]> {
  const errors: string[] = [];
  const extracted: ExtractedFields = {};

  const byKind = new Map<TemplateFieldKind, TemplateField>();
  for (const field of template.fields) byKind.set(field.kind, field);

  // --- currency, first: the money transforms depend on it ---
  let currency = context.defaultCurrency;
  const currencyField = byKind.get('currency');
  if (currencyField) {
    const raw = rawValueFor(currencyField, groups);
    if (!raw.ok) {
      errors.push(raw.error);
    } else {
      const parsed = parseCurrency(raw.value);
      if (!parsed.ok) errors.push(parsed.error);
      else currency = parsed.value;
    }
  }
  extracted.currency = currency;

  for (const field of template.fields) {
    if (field.kind === 'currency') continue;

    const raw = rawValueFor(field, groups);
    if (!raw.ok) {
      errors.push(raw.error);
      continue;
    }

    switch (field.kind) {
      case 'amount': {
        const parsed = parseAmount(raw.value, currency);
        if (!parsed.ok) errors.push(`amount: ${parsed.error}`);
        else extracted.amount = parsed.value;
        break;
      }
      case 'balanceAfter': {
        const parsed = parseAmount(raw.value, currency);
        if (!parsed.ok) errors.push(`balanceAfter: ${parsed.error}`);
        else extracted.balanceAfter = parsed.value;
        break;
      }
      case 'direction': {
        const parsed = parseDirection(raw.value);
        if (!parsed.ok) errors.push(`direction: ${parsed.error}`);
        else extracted.direction = parsed.value;
        break;
      }
      case 'occurredAt': {
        if (!field.format) {
          errors.push('occurredAt: template declares no date format');
          break;
        }
        const parsed = parseDateTime(raw.value, field.format, context);
        if (!parsed.ok) errors.push(`occurredAt: ${parsed.error}`);
        else extracted.occurredAt = parsed.value;
        break;
      }
      case 'accountLast4': {
        const parsed = parseAccountLast4(raw.value);
        if (!parsed.ok) errors.push(`accountLast4: ${parsed.error}`);
        else extracted.accountLast4 = parsed.value;
        break;
      }
      case 'description': {
        // Collapse the whitespace multi-line alerts leave behind.
        extracted.description = raw.value.replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }

  return errors.length > 0 ? err(errors) : ok(extracted);
}

/**
 * Parses a message against candidate templates, newest version first.
 *
 * Candidates are the templates for the institution that owns `senderId`; resolving
 * sender to institution is the caller's job, so this stays a pure function.
 */
export function parseMessage(
  message: SourceMessage,
  candidates: readonly ParseTemplate[],
  context: ParseContext,
): Result<ParsedTransaction, ParseFailure> {
  if (message.body.length > MAX_MESSAGE_LENGTH) {
    // A guard against pathological input reaching the regex engine on a phone.
    return err({
      code: 'MESSAGE_TOO_LONG',
      detail: `${message.body.length} characters exceeds the ${MAX_MESSAGE_LENGTH} limit`,
    });
  }

  const ordered = [...candidates].sort((left, right) => right.version - left.version);

  for (const template of ordered) {
    const match = compilePattern(template).exec(message.body);
    if (!match) continue;

    const extracted = extractFields(template, match.groups ?? {}, context);

    if (!extracted.ok) {
      // The pattern matched, so this template claims the message. Falling through
      // to an older version would risk a different, subtly wrong reading.
      return err({
        code: 'FIELD_EXTRACTION_FAILED',
        detail: extracted.error.join('; '),
        attemptedTemplateId: template.id,
      });
    }

    const { amount, direction, occurredAt, currency } = extracted.value;

    if (!amount || !direction || !occurredAt || !currency) {
      return err({
        code: 'FIELD_EXTRACTION_FAILED',
        detail: 'template matched but did not yield amount, direction and occurredAt',
        attemptedTemplateId: template.id,
      });
    }

    return ok({
      amount,
      currency,
      direction,
      occurredAt,
      balanceAfter: extracted.value.balanceAfter ?? null,
      description: extracted.value.description ?? null,
      accountLast4: extracted.value.accountLast4 ?? null,
      templateId: template.id,
      templateVersion: template.version,
    });
  }

  return err({
    code: 'NO_TEMPLATE_MATCHED',
    detail: `no template for sender '${message.senderId}' matched`,
  });
}
