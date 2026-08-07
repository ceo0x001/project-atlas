import type { InstitutionId, TemplateId } from '@atlas/shared-kernel';

/**
 * Parse templates are data, not code (ADR-004).
 *
 * A template is shipped from the backend and executed on-device, so a new bank
 * message format reaches users without an app release. Claude may author a
 * candidate, but what runs in production is always this deterministic structure,
 * validated against fixtures before publication.
 */

export type IngestionChannel = 'SMS' | 'EMAIL';

export type TemplateFieldKind =
  | 'amountMinor'
  | 'currency'
  | 'direction'
  | 'occurredAt'
  | 'balanceAfterMinor'
  | 'description'
  | 'accountLast4';

export interface TemplateField {
  readonly kind: TemplateFieldKind;
  /** Named capture group in `matchPattern` supplying this field. */
  readonly group: string;
  /** Post-processing, e.g. strip thousands separators, parse a date format. */
  readonly transform?: string;
}

export interface ParseTemplate {
  readonly id: TemplateId;
  readonly institutionId: InstitutionId;
  readonly channel: IngestionChannel;
  readonly version: number;
  readonly name: string;
  readonly matchPattern: string;
  readonly fields: readonly TemplateField[];
}

/**
 * A worked example: input text plus the fields it must yield. Every template
 * carries its own regression suite, so a template that would break existing banks
 * cannot be published.
 */
export interface TemplateFixture {
  readonly input: string;
  readonly expected: Readonly<Record<string, string>>;
}

export interface TemplateValidationResult {
  readonly valid: boolean;
  readonly passed: number;
  readonly failed: readonly { readonly fixture: TemplateFixture; readonly reason: string }[];
}
