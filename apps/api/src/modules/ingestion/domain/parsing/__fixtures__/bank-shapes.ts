import { idFromSeed, type InstitutionId, type TemplateId } from '@atlas/shared-kernel';
import type { ParseTemplate, TemplateFixture } from '../../parse-template';

/**
 * Representative message shapes, for tests only.
 *
 * ⚠️ PROVENANCE WARNING ⚠️
 *
 * These are *representative message shapes*, reconstructed from the common
 * conventions of Nigerian bank alerts — labelled multi-line, prose single-line, and
 * fintech debit-only. They have NOT been validated against real messages from a
 * real SIM, and the institution names are omitted deliberately so nobody mistakes
 * them for verified bank formats.
 *
 * Their job right now is to exercise the engine across the structural variety it
 * must handle. The first task with the physical Android device (ADR-006
 * Amendment 1) is capturing genuine alerts and replacing these with real,
 * bank-attributed templates.
 *
 * Treat a green test suite here as "the engine works", never as "we can parse
 * GTBank".
 */

export interface RepresentativeShape {
  readonly template: ParseTemplate;
  readonly fixtures: readonly TemplateFixture[];
}

const institution = (seed: number): InstitutionId => idFromSeed<'InstitutionId'>(seed);
const template = (seed: number): TemplateId => idFromSeed<'TemplateId'>(seed);

/**
 * Shape A — labelled multi-line alert.
 * Direction is stated as a DR/CR token; every field is explicitly labelled.
 */
const labelledMultiline: RepresentativeShape = {
  template: {
    id: template(1),
    institutionId: institution(1),
    channel: 'SMS',
    version: 1,
    name: 'shape-a-labelled-multiline',
    matchPattern:
      'Acct:\\s*\\**(?<acct>\\d{4})' +
      '\\s*Amt:\\s*(?<cur>NGN|USD)\\s*(?<amt>[\\d,]+\\.\\d{2})' +
      '\\s*(?<dir>DR|CR)' +
      '\\s*Desc:\\s*(?<desc>.*?)' +
      '\\s*Time:\\s*(?<when>\\d{2}-[A-Z]{3}-\\d{4} \\d{2}:\\d{2}:\\d{2})' +
      '\\s*Bal:\\s*(?:NGN|USD)\\s*(?<bal>[\\d,]+\\.\\d{2})',
    fields: [
      { kind: 'accountLast4', group: 'acct' },
      { kind: 'currency', group: 'cur' },
      { kind: 'amount', group: 'amt' },
      { kind: 'direction', group: 'dir' },
      { kind: 'description', group: 'desc' },
      { kind: 'occurredAt', group: 'when', format: 'DD-MMM-YYYY HH:mm:ss' },
      { kind: 'balanceAfter', group: 'bal' },
    ],
  },
  fixtures: [
    {
      input:
        'Acct: **1234\nAmt: NGN5,000.00 DR\nDesc: TRF/JOHN DOE/RENT\n' +
        'Time: 07-AUG-2026 14:23:45\nBal: NGN45,200.15',
      expected: {
        accountLast4: '1234',
        currency: 'NGN',
        amount: '5000.00',
        direction: 'DEBIT',
        description: 'TRF/JOHN DOE/RENT',
        occurredAt: '2026-08-07T13:23:45.000Z',
        balanceAfter: '45200.15',
      },
    },
    {
      input:
        'Acct: **9876\nAmt: NGN250,000.00 CR\nDesc: SALARY AUG\n' +
        'Time: 25-JUL-2026 09:05:00\nBal: NGN295,200.15',
      expected: {
        accountLast4: '9876',
        amount: '250000.00',
        direction: 'CREDIT',
        description: 'SALARY AUG',
        occurredAt: '2026-07-25T08:05:00.000Z',
        balanceAfter: '295200.15',
      },
    },
  ],
};

/**
 * Shape B — prose single-line alert.
 * Direction is a verb; the date carries no time, so it lands at local midnight.
 */
const proseSingleLine: RepresentativeShape = {
  template: {
    id: template(2),
    institutionId: institution(2),
    channel: 'SMS',
    version: 1,
    name: 'shape-b-prose-single-line',
    matchPattern:
      'account\\s+X*(?<acct>\\d{4})\\s+has been\\s+(?<dir>debited|credited)' +
      '\\s+with\\s+(?<cur>NGN|USD)(?<amt>[\\d,]+\\.\\d{2})' +
      '\\s+on\\s+(?<when>\\d{2}/\\d{2}/\\d{4})\\.' +
      '\\s*Desc:\\s*(?<desc>.*?)\\.' +
      '\\s*Avail Bal:\\s*(?:NGN|USD)(?<bal>[\\d,]+\\.\\d{2})',
    fields: [
      { kind: 'accountLast4', group: 'acct' },
      { kind: 'currency', group: 'cur' },
      { kind: 'amount', group: 'amt' },
      { kind: 'direction', group: 'dir' },
      { kind: 'description', group: 'desc' },
      { kind: 'occurredAt', group: 'when', format: 'DD/MM/YYYY' },
      { kind: 'balanceAfter', group: 'bal' },
    ],
  },
  fixtures: [
    {
      input:
        'Your account XXXXX1234 has been debited with NGN5,000.00 on 07/08/2026. ' +
        'Desc: TRANSFER TO MUSA. Avail Bal: NGN45,200.15',
      expected: {
        accountLast4: '1234',
        amount: '5000.00',
        direction: 'DEBIT',
        description: 'TRANSFER TO MUSA',
        // No time in the message, so local midnight — 23:00 UTC the previous day.
        occurredAt: '2026-08-06T23:00:00.000Z',
        balanceAfter: '45200.15',
      },
    },
  ],
};

/**
 * Shape C — fintech debit-only notification.
 * The message never says "debit", so direction is a template literal. This is the
 * case the original field model could not express.
 */
const debitOnlyLiteral: RepresentativeShape = {
  template: {
    id: template(3),
    institutionId: institution(3),
    channel: 'SMS',
    version: 1,
    name: 'shape-c-debit-only',
    matchPattern:
      'Payment of\\s+(?<cur>NGN|USD)(?<amt>[\\d,]+\\.\\d{2})' +
      '\\s+to\\s+(?<desc>.*?)' +
      '\\s+on\\s+(?<when>\\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2})\\.' +
      '\\s*Bal:\\s*(?:NGN|USD)(?<bal>[\\d,]+\\.\\d{2})',
    fields: [
      { kind: 'currency', group: 'cur' },
      { kind: 'amount', group: 'amt' },
      { kind: 'direction', literal: 'DR' },
      { kind: 'description', group: 'desc' },
      { kind: 'occurredAt', group: 'when', format: 'DD/MM/YYYY HH:mm' },
      { kind: 'balanceAfter', group: 'bal' },
    ],
  },
  fixtures: [
    {
      input: 'Payment of NGN2,500.00 to MTN VTU on 07/08/2026 14:23. Bal: NGN12,000.00',
      expected: {
        amount: '2500.00',
        direction: 'DEBIT',
        description: 'MTN VTU',
        occurredAt: '2026-08-07T13:23:00.000Z',
        balanceAfter: '12000.00',
      },
    },
  ],
};

export const REPRESENTATIVE_SHAPES: readonly RepresentativeShape[] = [
  labelledMultiline,
  proseSingleLine,
  debitOnlyLiteral,
];
