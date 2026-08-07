/**
 * Resolves relative periods ("this month", "last week") into exact UTC instants.
 *
 * This is deliberately **not** the model's job. Asking a language model to compute
 * "the first instant of this month in Africa/Lagos, as UTC" invites a plausible,
 * wrong answer — and a spending total over the wrong window is indistinguishable
 * from a hallucinated one. The model names a period; the ledger decides what that
 * period means.
 *
 * Week boundaries are Monday-based, matching Postgres `date_trunc('week', …)`, so a
 * "this week" filter and a week-grouped aggregation always agree.
 */

export type NamedPeriod =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year'
  | 'last_7_days'
  | 'last_30_days';

export interface ResolvedPeriod {
  /** Inclusive lower bound. */
  readonly from: Date;
  /** Inclusive upper bound — the ledger filter uses `occurredAt <= to`. */
  readonly to: Date;
  /** Human label, for the canvas and for the assistant to echo. */
  readonly label: string;
}

interface ZonedDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Wall-clock fields of an instant, as observed in a zone. */
function zonedFields(instant: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }

  // Intl renders midnight as hour 24 in some engines; normalise to 0.
  if (fields['hour'] === 24) fields['hour'] = 0;

  return fields;
}

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const f = zonedFields(instant, timeZone);
  const asIfUtc = Date.UTC(
    f['year'] as number,
    (f['month'] as number) - 1,
    f['day'] as number,
    f['hour'] as number,
    f['minute'] as number,
    f['second'] as number,
  );

  return (asIfUtc - instant.getTime()) / MS_PER_MINUTE;
}

/**
 * The UTC instant of local midnight on a given calendar date in a zone.
 *
 * Resolved in two passes: the offset needed to convert local→UTC depends on the
 * instant being computed, which is circular. One correction pass settles it, and is
 * what makes DST transitions land on the right side of the boundary.
 */
function zonedMidnightUtc(date: ZonedDate, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day);

  const firstGuess = naive - offsetMinutesAt(new Date(naive), timeZone) * MS_PER_MINUTE;
  const corrected = naive - offsetMinutesAt(new Date(firstGuess), timeZone) * MS_PER_MINUTE;

  return new Date(corrected);
}

/** Today's calendar date, as observed in the zone. */
function todayIn(timeZone: string, now: Date): ZonedDate {
  const f = zonedFields(now, timeZone);

  return { year: f['year'] as number, month: f['month'] as number, day: f['day'] as number };
}

function addDays(date: ZonedDate, days: number): ZonedDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Monday of the week containing `date`. */
function startOfWeek(date: ZonedDate): ZonedDate {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  // getUTCDay: Sunday = 0. Shift so Monday is the origin.
  const daysSinceMonday = (weekday + 6) % 7;

  return addDays(date, -daysSinceMonday);
}

/** One millisecond before the next local midnight — the inclusive end of a day. */
function endOfDayUtc(date: ZonedDate, timeZone: string): Date {
  return new Date(zonedMidnightUtc(addDays(date, 1), timeZone).getTime() - 1);
}

function monthLabel(date: ZonedDate, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long', year: 'numeric' }).format(
    zonedMidnightUtc(date, timeZone),
  );
}

function dayLabel(date: ZonedDate, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(zonedMidnightUtc(date, timeZone));
}

/**
 * Current-period ranges end at the end of *today*, not at `now`.
 *
 * "How much have I spent this month" should include a purchase made twenty minutes
 * ago even if a device clock ran slightly fast — cutting the window at the current
 * instant would silently drop it.
 */
export function resolvePeriod(period: NamedPeriod, timeZone: string, now: Date): ResolvedPeriod {
  const today = todayIn(timeZone, now);
  const start = (date: ZonedDate): Date => zonedMidnightUtc(date, timeZone);
  const end = (date: ZonedDate): Date => endOfDayUtc(date, timeZone);

  switch (period) {
    case 'today':
      return { from: start(today), to: end(today), label: `today, ${dayLabel(today, timeZone)}` };

    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return {
        from: start(yesterday),
        to: end(yesterday),
        label: `yesterday, ${dayLabel(yesterday, timeZone)}`,
      };
    }

    case 'this_week':
      return { from: start(startOfWeek(today)), to: end(today), label: 'this week' };

    case 'last_week': {
      const lastMonday = addDays(startOfWeek(today), -7);
      return { from: start(lastMonday), to: end(addDays(lastMonday, 6)), label: 'last week' };
    }

    case 'this_month': {
      const first = { ...today, day: 1 };
      return { from: start(first), to: end(today), label: monthLabel(first, timeZone) };
    }

    case 'last_month': {
      const firstOfThis = { ...today, day: 1 };
      const lastDayOfPrevious = addDays(firstOfThis, -1);
      const firstOfPrevious = { ...lastDayOfPrevious, day: 1 };
      return {
        from: start(firstOfPrevious),
        to: end(lastDayOfPrevious),
        label: monthLabel(firstOfPrevious, timeZone),
      };
    }

    case 'this_year': {
      const first = { year: today.year, month: 1, day: 1 };
      return { from: start(first), to: end(today), label: String(today.year) };
    }

    case 'last_year': {
      const first = { year: today.year - 1, month: 1, day: 1 };
      return {
        from: start(first),
        to: end({ year: today.year - 1, month: 12, day: 31 }),
        label: String(today.year - 1),
      };
    }

    case 'last_7_days':
      // Inclusive of today, so six days back.
      return { from: start(addDays(today, -6)), to: end(today), label: 'the last 7 days' };

    case 'last_30_days':
      return { from: start(addDays(today, -29)), to: end(today), label: 'the last 30 days' };

    default: {
      const exhaustive: never = period;
      throw new Error(`unsupported period '${String(exhaustive)}'`);
    }
  }
}

/**
 * Resolves an explicit `YYYY-MM-DD` range to inclusive UTC instants in a zone.
 *
 * Used only when the caller genuinely means specific dates. Named periods are
 * preferred, because they take the date arithmetic away from the model entirely.
 */
export function resolveExplicitRange(
  fromIsoDate: string,
  toIsoDate: string,
  timeZone: string,
): ResolvedPeriod | null {
  const parse = (value: string): ZonedDate | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;

    const [, year, month, day] = match as unknown as [string, string, string, string];
    const candidate = { year: Number(year), month: Number(month), day: Number(day) };

    // Reject dates that do not exist rather than letting Date roll them over.
    const roundTrip = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day));
    if (
      roundTrip.getUTCFullYear() !== candidate.year ||
      roundTrip.getUTCMonth() + 1 !== candidate.month ||
      roundTrip.getUTCDate() !== candidate.day
    ) {
      return null;
    }

    return candidate;
  };

  const from = parse(fromIsoDate);
  const to = parse(toIsoDate);
  if (!from || !to) return null;

  const start = zonedMidnightUtc(from, timeZone);
  const end = endOfDayUtc(to, timeZone);
  if (start.getTime() > end.getTime()) return null;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return {
    from: start,
    to: end,
    label: `${formatter.format(start)} to ${formatter.format(end)}`,
  };
}

/** Validates an IANA zone before it reaches Postgres or a formatter. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
