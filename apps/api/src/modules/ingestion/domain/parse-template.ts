import type { InstitutionId, TemplateId } from '@atlas/shared-kernel';

/**
 * Parse templates are data, not code (ADR-004).
 *
 * A template is shipped from the backend and executed on-device, so a new bank
 * message format reaches users without an app release. Claude may author a
 * candidate, but what runs in production is always this deterministic structure,
 * validated against fixtures before publication.
 *
 * The same definition is executed by TypeScript on the server and Dart on the
 * device, so the pattern must use only constructs both runtimes agree on.
 */

export type IngestionChannel = 'SMS' | 'EMAIL';

export type TemplateFieldKind =
  | 'amount'
  | 'currency'
  | 'direction'
  | 'occurredAt'
  | 'balanceAfter'
  | 'description'
  | 'accountLast4';

/** Fields without which an observation is not a transaction. */
export const REQUIRED_FIELD_KINDS: readonly TemplateFieldKind[] = [
  'amount',
  'direction',
  'occurredAt',
];

export interface TemplateField {
  readonly kind: TemplateFieldKind;
  /**
   * Named capture group in `matchPattern` supplying the raw value.
   * Mutually exclusive with `literal`.
   */
  readonly group?: string;
  /**
   * Constant value, for facts the message shape implies rather than states — a
   * debit-only alert template carries `direction: 'DR'` as a literal because the
   * word never appears in the text.
   */
  readonly literal?: string;
  /**
   * Date format token string, required for `occurredAt`. See transforms.ts for the
   * supported tokens. Formats are explicit because DD/MM and MM/DD are
   * indistinguishable from the text alone, and guessing puts wrong dates in the
   * ledger.
   */
  readonly format?: string;
}

export interface ParseTemplate {
  readonly id: TemplateId;
  readonly institutionId: InstitutionId;
  readonly channel: IngestionChannel;
  readonly version: number;
  readonly name: string;
  /** Regex source. Compiled case-insensitively with dot-matches-newline. */
  readonly matchPattern: string;
  readonly fields: readonly TemplateField[];
}

/**
 * A worked example: input text plus the field values it must yield. Every template
 * carries its own regression suite, so a template that would break a bank that
 * currently works cannot be published.
 */
export interface TemplateFixture {
  readonly input: string;
  /** Expected values keyed by field kind, as canonical strings. */
  readonly expected: Readonly<Partial<Record<TemplateFieldKind, string>>>;
}

export interface TemplateDefect {
  readonly code:
    | 'PATTERN_INVALID'
    | 'PATTERN_UNSAFE'
    | 'MISSING_REQUIRED_FIELD'
    | 'UNKNOWN_GROUP'
    | 'FIELD_SOURCE_AMBIGUOUS'
    | 'MISSING_DATE_FORMAT'
    | 'FIXTURE_FAILED';
  readonly detail: string;
}

export interface TemplateValidationResult {
  readonly valid: boolean;
  readonly defects: readonly TemplateDefect[];
  readonly fixturesPassed: number;
  readonly fixturesTotal: number;
}
