import { describe, expect, it } from 'vitest';
import { isKnownTimeZone, type NamedPeriod, resolvePeriod } from './period';

const LAGOS = 'Africa/Lagos';
/** Observes DST, so it exercises the offset-correction pass. */
const NEW_YORK = 'America/New_York';

/** Friday 7 August 2026, 14:23 Lagos time (13:23 UTC). */
const midAugust = new Date('2026-08-07T13:23:45Z');

function range(period: NamedPeriod, zone = LAGOS, now = midAugust) {
  const resolved = resolvePeriod(period, zone, now);

  return {
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    label: resolved.label,
  };
}

describe('resolvePeriod in Africa/Lagos (UTC+1, no DST)', () => {
  it('resolves today to local midnight through the end of the local day', () => {
    // Local midnight on 7 August is 23:00 UTC on 6 August.
    expect(range('today')).toMatchObject({
      from: '2026-08-06T23:00:00.000Z',
      to: '2026-08-07T22:59:59.999Z',
    });
  });

  it('resolves yesterday as a complete local day', () => {
    expect(range('yesterday')).toMatchObject({
      from: '2026-08-05T23:00:00.000Z',
      to: '2026-08-06T22:59:59.999Z',
    });
  });

  it('starts the week on Monday, matching date_trunc', () => {
    // 7 August 2026 is a Friday; that week's Monday is the 3rd.
    expect(range('this_week').from).toBe('2026-08-02T23:00:00.000Z');
  });

  it('resolves last week as Monday through Sunday', () => {
    expect(range('last_week')).toMatchObject({
      from: '2026-07-26T23:00:00.000Z',
      to: '2026-08-02T22:59:59.999Z',
    });
  });

  it('resolves this month from the first of the month to the end of today', () => {
    expect(range('this_month')).toMatchObject({
      from: '2026-07-31T23:00:00.000Z',
      to: '2026-08-07T22:59:59.999Z',
      label: 'August 2026',
    });
  });

  it('resolves last month as a complete month', () => {
    expect(range('last_month')).toMatchObject({
      from: '2026-06-30T23:00:00.000Z',
      to: '2026-07-31T22:59:59.999Z',
      label: 'July 2026',
    });
  });

  it('counts last_7_days inclusively of today', () => {
    // 1 August through 7 August is seven days.
    expect(range('last_7_days').from).toBe('2026-07-31T23:00:00.000Z');
  });

  it('resolves calendar years', () => {
    expect(range('this_year').from).toBe('2025-12-31T23:00:00.000Z');
    expect(range('last_year')).toMatchObject({
      from: '2024-12-31T23:00:00.000Z',
      to: '2025-12-31T22:59:59.999Z',
      label: '2025',
    });
  });
});

describe('month and year boundaries', () => {
  it('rolls last_month back across a year boundary', () => {
    const january = new Date('2026-01-15T12:00:00Z');

    expect(range('last_month', LAGOS, january)).toMatchObject({
      from: '2025-11-30T23:00:00.000Z',
      to: '2025-12-31T22:59:59.999Z',
      label: 'December 2025',
    });
  });

  it('handles the first of the month, where today is also the range start', () => {
    // 00:30 Lagos on 1 September — a moment that is still August in UTC.
    const firstOfSeptember = new Date('2026-08-31T23:30:00Z');
    const resolved = range('this_month', LAGOS, firstOfSeptember);

    expect(resolved.label).toBe('September 2026');
    expect(resolved.from).toBe('2026-08-31T23:00:00.000Z');
  });

  it('gets February right in a leap year', () => {
    const march = new Date('2024-03-10T12:00:00Z');

    expect(range('last_month', LAGOS, march)).toMatchObject({
      from: '2024-01-31T23:00:00.000Z',
      to: '2024-02-29T22:59:59.999Z',
    });
  });
});

describe('zones that observe daylight saving', () => {
  it('resolves a full month across a spring-forward transition', () => {
    // US DST began 8 March 2026. March starts at EST (-5) and ends at EDT (-4).
    const april = new Date('2026-04-10T12:00:00Z');
    const resolved = range('last_month', NEW_YORK, april);

    expect(resolved.from).toBe('2026-03-01T05:00:00.000Z'); // midnight EST
    expect(resolved.to).toBe('2026-04-01T03:59:59.999Z'); // end of 31 March, EDT
  });

  it('resolves a day inside the DST offset correctly', () => {
    const summer = new Date('2026-07-04T16:00:00Z');

    // Midnight EDT on 4 July is 04:00 UTC.
    expect(range('today', NEW_YORK, summer).from).toBe('2026-07-04T04:00:00.000Z');
  });

  it('resolves a day outside the DST offset correctly', () => {
    const winter = new Date('2026-01-15T17:00:00Z');

    // Midnight EST on 15 January is 05:00 UTC.
    expect(range('today', NEW_YORK, winter).from).toBe('2026-01-15T05:00:00.000Z');
  });
});

describe('range invariants', () => {
  const periods: NamedPeriod[] = [
    'today',
    'yesterday',
    'this_week',
    'last_week',
    'this_month',
    'last_month',
    'this_year',
    'last_year',
    'last_7_days',
    'last_30_days',
  ];

  it.each(periods)('%s produces a non-empty range with from before to', (period) => {
    const resolved = resolvePeriod(period, LAGOS, midAugust);

    expect(resolved.from.getTime()).toBeLessThan(resolved.to.getTime());
    expect(resolved.label).not.toBe('');
  });

  it.each(periods)('%s ends on a millisecond boundary of local midnight', (period) => {
    // Every upper bound is inclusive: one millisecond before a local midnight.
    expect(resolvePeriod(period, LAGOS, midAugust).to.getMilliseconds()).toBe(999);
  });
});

describe('isKnownTimeZone', () => {
  it.each(['Africa/Lagos', 'UTC', 'America/New_York', 'Europe/London'])('accepts %s', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(true);
  });

  it.each(['Mars/Olympus', 'Not/AZone', ''])('rejects %s', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(false);
  });
});
