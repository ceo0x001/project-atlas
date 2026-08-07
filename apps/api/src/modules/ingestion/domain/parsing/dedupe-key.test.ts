import { idFromSeed, type ObservationId } from '@atlas/shared-kernel';
import { describe, expect, it } from 'vitest';
import {
  normaliseForHash,
  smsDedupeKey,
  type SmsDedupeInput,
  statementRowDedupeKey,
  type StatementRowDedupeInput,
  userStatedDedupeKey,
} from './dedupe-key';

const sms: SmsDedupeInput = {
  senderId: 'TESTBANK',
  body: 'Acct: **1234\nAmt: NGN5,000.00 DR',
  receivedAt: new Date('2026-08-07T13:23:45Z'),
};

const statementRow: StatementRowDedupeInput = {
  accountLast4: '1234',
  occurredAt: new Date('2026-08-07T13:23:45Z'),
  amountMinor: 500_000n,
  currency: 'NGN',
  direction: 'DEBIT',
  description: 'TRF/JOHN DOE',
  reference: null,
  occurrenceIndex: 0,
};

describe('normaliseForHash', () => {
  it('collapses insignificant whitespace', () => {
    expect(normaliseForHash('  a   b \n c  ')).toBe('a b c');
  });

  it('preserves case, which can be meaningful in a narration', () => {
    expect(normaliseForHash('MTN vtu')).toBe('MTN vtu');
  });
});

describe('smsDedupeKey', () => {
  it('is stable — re-reading the inbox must not duplicate a transaction', () => {
    expect(smsDedupeKey(sms)).toBe(smsDedupeKey({ ...sms }));
  });

  it('is insensitive to whitespace differences between read paths', () => {
    expect(smsDedupeKey({ ...sms, body: 'Acct: **1234   Amt: NGN5,000.00 DR' })).toBe(
      smsDedupeKey({ ...sms, body: 'Acct: **1234 Amt:  NGN5,000.00  DR' }),
    );
  });

  it.each([
    ['sender', { senderId: 'OTHERBANK' }],
    ['body', { body: 'Acct: **1234\nAmt: NGN6,000.00 DR' }],
    ['timestamp', { receivedAt: new Date('2026-08-07T13:23:46Z') }],
  ])('changes when the %s changes', (_field, patch) => {
    expect(smsDedupeKey({ ...sms, ...patch })).not.toBe(smsDedupeKey(sms));
  });

  it('produces a hex digest rather than leaking message content', () => {
    const key = smsDedupeKey(sms);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('1234');
  });
});

describe('statementRowDedupeKey', () => {
  it('is stable across re-imports of the same statement', () => {
    expect(statementRowDedupeKey(statementRow)).toBe(statementRowDedupeKey({ ...statementRow }));
  });

  it('keeps two genuinely identical purchases on one day distinct', () => {
    // Without the ordinal these collapse into one, understating spending.
    expect(statementRowDedupeKey({ ...statementRow, occurrenceIndex: 1 })).not.toBe(
      statementRowDedupeKey(statementRow),
    );
  });

  it('prefers the bank reference over the positional ordinal', () => {
    // With a reference, the key must survive the row moving between overlapping
    // statement exports.
    const first = statementRowDedupeKey({
      ...statementRow,
      reference: 'REF123',
      occurrenceIndex: 0,
    });
    const moved = statementRowDedupeKey({
      ...statementRow,
      reference: 'REF123',
      occurrenceIndex: 7,
    });

    expect(first).toBe(moved);
  });

  it.each([
    ['amount', { amountMinor: 600_000n }],
    ['direction', { direction: 'CREDIT' as const }],
    ['date', { occurredAt: new Date('2026-08-08T13:23:45Z') }],
    ['account', { accountLast4: '9999' }],
    ['currency', { currency: 'USD' }],
  ])('changes when the %s changes', (_field, patch) => {
    expect(statementRowDedupeKey({ ...statementRow, ...patch })).not.toBe(
      statementRowDedupeKey(statementRow),
    );
  });
});

describe('cross-source behaviour', () => {
  it('gives the same transaction different keys per source, on purpose', () => {
    // Both observations are genuine and independent. Collapsing them here would
    // discard the corroboration that reconciliation uses to detect gaps.
    expect(smsDedupeKey(sms)).not.toBe(statementRowDedupeKey(statementRow));
  });
});

describe('userStatedDedupeKey', () => {
  it('keys on the observation id, so identical statements stay separate', () => {
    const first = idFromSeed<'ObservationId'>(1) as ObservationId;
    const second = idFromSeed<'ObservationId'>(2) as ObservationId;

    expect(userStatedDedupeKey(first)).toBe(userStatedDedupeKey(first));
    expect(userStatedDedupeKey(first)).not.toBe(userStatedDedupeKey(second));
  });
});
