import type { CategoryId, CurrencyCode, MerchantId, TransactionId } from '@atlas/shared-kernel';

/**
 * Finds recurring money — bills, income, and habits — in a transaction history.
 *
 * Pure and deterministic. No model is involved, and that is the point: a rhythm in a list of dates
 * is arithmetic, and calling an LLM for it would make the answer unverifiable and non-repeatable
 * for no gain. The model's job comes later, deciding which of these is worth mentioning.
 *
 * ## The distinction that matters
 *
 * A *bill* and a *habit* are both recurring, and confusing them makes the product annoying. DSTV
 * at ₦24,500 on the 3rd of each month is an obligation, and a missed one is worth flagging. Buying
 * fuel most Fridays is a rhythm, and "you missed your Friday fuel" is noise. The difference is not
 * the regularity of the dates — both are regular — it is the **stability of the amount**. Bills are
 * the same figure; habits vary.
 *
 * ## What is deliberately not attempted
 *
 * A payee whose history contains two different rhythms — a big monthly shop and small daily items
 * at the same supermarket — is treated as one irregular series and reported as nothing. Splitting
 * it would need clustering, and a clustering heuristic that is wrong produces a confident bill that
 * does not exist. Reporting nothing is the honest failure.
 */

export type Cadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'IRREGULAR';

/** What kind of recurring money this is, which decides whether a miss is worth mentioning. */
export type SeriesKind = 'BILL' | 'INCOME' | 'HABIT';

export interface RecurringInput {
  readonly transactionId: TransactionId;
  readonly occurredAt: Date;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly description: string;
  readonly merchantId: MerchantId | null;
  readonly categoryId: CategoryId | null;
}

export interface RecurringCandidate {
  /** Stable across runs for the same payee and shape, so a re-detection updates rather than duplicates. */
  readonly key: string;
  readonly label: string;
  readonly kind: SeriesKind;
  readonly cadence: Cadence;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly currency: CurrencyCode;
  /** Typical days between occurrences — the median, so one missed payment does not distort it. */
  readonly intervalDays: number;
  /**
   * An amount that **actually occurred** — the median of the observed values, never a computed
   * average. A mean would invent a figure no transaction ever had, and this number gets read out
   * loud.
   *
   * For a `BILL` this is what to expect. For a `HABIT` it is only what is typical, and a caller
   * should say "usually" rather than "will be" — the amount varying is what made it a habit.
   */
  readonly expectedAmountMinor: bigint;
  readonly occurrences: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly nextExpectedAt: Date;
  /**
   * 0–1. How confident that this is a real rhythm — evenness of spacing weighted by how much
   * history supports it. Deliberately independent of whether the *amount* is predictable, which is
   * what `kind` reports.
   */
  readonly confidence: number;
  readonly merchantId: MerchantId | null;
  readonly categoryId: CategoryId | null;
  readonly transactionIds: readonly TransactionId[];
}

/**
 * Two points define an interval; three are needed before there is a rhythm to check. Requiring
 * three is what stops a pair of coincidental payments becoming "your monthly bill".
 */
export const MIN_OCCURRENCES = 3;

/** Below this, a candidate is coincidence dressed as a pattern and is not reported. */
export const MIN_CONFIDENCE = 0.55;

/**
 * A bill's amount barely moves. Above this stability it is an obligation; below, a habit.
 *
 * Note what this threshold does *not* do: it does not decide whether the pattern is real. That
 * distinction cost me a rewrite. Confidence originally multiplied in amount stability, which meant
 * a perfectly weekly fuel habit with amounts varying two-fold scored 0.32 and was discarded —
 * even though the rhythm was flawless. One number was being asked two different questions.
 *
 * They are separate: **confidence answers "is this a real rhythm", and stability answers "is the
 * amount predictable".** A bill needs both. A habit needs only the first, because varying is what
 * makes it a habit rather than a bill.
 */
const BILL_AMOUNT_STABILITY = 0.88;

/**
 * The floor below which amounts are not a pattern at all, only noise.
 *
 * Deliberately loose. It exists to reject a wrongly-merged group — unrelated card purchases sharing
 * a generic narration, spanning fifty-fold — without rejecting a genuine habit that varies by half.
 */
const MIN_AMOUNT_COHERENCE = 0.25;

interface CadenceWindow {
  readonly cadence: Exclude<Cadence, 'IRREGULAR'>;
  readonly low: number;
  readonly high: number;
  readonly nominal: number;
}

/**
 * Monthly is a range rather than a number because calendar months are not equal: the 31st of
 * January to the 28th of February is 28 days, and the 5th to the 5th can be 31.
 */
const CADENCE_WINDOWS: readonly CadenceWindow[] = [
  { cadence: 'WEEKLY', low: 6, high: 8, nominal: 7 },
  { cadence: 'BIWEEKLY', low: 12, high: 16, nominal: 14 },
  { cadence: 'MONTHLY', low: 27, high: 34, nominal: 30 },
  { cadence: 'QUARTERLY', low: 85, high: 96, nominal: 91 },
  { cadence: 'ANNUAL', low: 350, high: 380, nominal: 365 },
];

export function detectRecurringSeries(
  transactions: readonly RecurringInput[],
): readonly RecurringCandidate[] {
  const groups = new Map<string, RecurringInput[]>();

  for (const transaction of transactions) {
    const key = groupKey(transaction);
    if (key === null) continue;

    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [transaction]);
    else existing.push(transaction);
  }

  const candidates: RecurringCandidate[] = [];

  for (const [key, group] of groups) {
    const candidate = describeGroup(key, group);
    if (candidate !== null) candidates.push(candidate);
  }

  // Most confident first, so a caller taking the top few takes the most trustworthy few.
  return candidates.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
}

/**
 * Groups transactions that could be the same obligation.
 *
 * A merchant id is used when one exists because it is an identity rather than a guess. Otherwise
 * the narration is normalised, which is genuinely lossy — bank narrations carry per-transaction
 * references, so the digits have to go. That over-groups: "POS PURCHASE 1234" and "POS PURCHASE
 * 9876" become one group even when they are unrelated.
 *
 * That is tolerable only because grouping is not the test. A wrongly merged group has scattered
 * dates and wildly different amounts, so it fails the cadence and stability checks and is reported
 * as nothing. The arithmetic is the gate, not the string.
 */
function groupKey(transaction: RecurringInput): string | null {
  const payee =
    transaction.merchantId !== null
      ? `m:${transaction.merchantId}`
      : `d:${normaliseNarration(transaction.description)}`;

  // A narration that normalises to nothing carries no identity at all — grouping on it would
  // collect every unlabelled transaction into one meaningless pile.
  if (payee === 'd:') return null;

  return `${transaction.direction}|${transaction.currency}|${payee}`;
}

/**
 * Strips the parts of a narration that change every time.
 *
 * Digits go because they are references, terminal ids and dates. Short leftovers are rejected: two
 * characters is not an identity.
 */
export function normaliseNarration(description: string): string {
  const stripped = description
    .toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.length >= 3 ? stripped : '';
}

function describeGroup(key: string, group: readonly RecurringInput[]): RecurringCandidate | null {
  if (group.length < MIN_OCCURRENCES) return null;

  const ordered = [...group].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return null;

  const gaps = intervalDays(ordered);
  if (gaps.length === 0) return null;

  const typicalGap = median(gaps);
  const window = CADENCE_WINDOWS.find((w) => typicalGap >= w.low && typicalGap <= w.high);

  // No recognisable rhythm. Reported as nothing rather than as an "irregular series", because an
  // irregular series is just a list of transactions and the user already has one of those.
  if (window === undefined) return null;

  const rhythm = regularity(gaps, typicalGap);
  const stability = amountStability(ordered);

  // Amounts spread so widely that the group is noise rather than a payee. Checked separately from
  // confidence, because a habit is *supposed* to vary.
  if (stability < MIN_AMOUNT_COHERENCE) return null;

  const confidence = round2(rhythm * occurrenceWeight(ordered.length));

  if (confidence < MIN_CONFIDENCE) return null;

  const expectedAmountMinor = medianAmount(ordered);
  const kind: SeriesKind =
    first.direction === 'CREDIT' ? 'INCOME' : stability >= BILL_AMOUNT_STABILITY ? 'BILL' : 'HABIT';

  return {
    key,
    label: label(ordered),
    kind,
    cadence: window.cadence,
    direction: first.direction,
    currency: first.currency,
    intervalDays: Math.round(typicalGap),
    expectedAmountMinor,
    occurrences: ordered.length,
    firstSeenAt: first.occurredAt,
    lastSeenAt: last.occurredAt,
    nextExpectedAt: projectNext(last.occurredAt, window, ordered),
    confidence,
    merchantId: first.merchantId,
    categoryId: first.categoryId,
    transactionIds: ordered.map((entry) => entry.transactionId),
  };
}

/**
 * Projects the next occurrence.
 *
 * For monthly and longer, calendar arithmetic is used rather than adding days: a bill on the 31st
 * should land on the 30th of a 30-day month, not spill into the next one. Day-of-month is taken
 * from the most common observed day, so one late payment does not move the whole expectation.
 */
function projectNext(
  lastSeenAt: Date,
  window: CadenceWindow,
  ordered: readonly RecurringInput[],
): Date {
  if (window.cadence === 'WEEKLY' || window.cadence === 'BIWEEKLY') {
    return new Date(lastSeenAt.getTime() + window.nominal * 86_400_000);
  }

  const monthsAhead = window.cadence === 'MONTHLY' ? 1 : window.cadence === 'QUARTERLY' ? 3 : 12;
  const day = commonDayOfMonth(ordered);

  const target = new Date(
    Date.UTC(lastSeenAt.getUTCFullYear(), lastSeenAt.getUTCMonth() + monthsAhead, 1),
  );

  // Clamped to the month's length: a bill due on the 31st is due on the 30th in November, not on
  // the 1st of December.
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(day, daysInMonth));

  return target;
}

function commonDayOfMonth(ordered: readonly RecurringInput[]): number {
  const counts = new Map<number, number>();

  for (const entry of ordered) {
    const day = entry.occurredAt.getUTCDate();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  let best = ordered[ordered.length - 1]?.occurredAt.getUTCDate() ?? 1;
  let bestCount = 0;

  for (const [day, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = day;
      bestCount = count;
    }
  }

  return best;
}

function intervalDays(ordered: readonly RecurringInput[]): readonly number[] {
  const gaps: number[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;

    gaps.push((current.occurredAt.getTime() - previous.occurredAt.getTime()) / 86_400_000);
  }

  return gaps;
}

/**
 * How evenly spaced the occurrences are, as 0–1.
 *
 * Measured against the median rather than the mean so that a single missed payment — which doubles
 * one gap — degrades the score instead of destroying it. A skipped month should lower confidence,
 * not erase a bill that has been paid eight times.
 */
function regularity(gaps: readonly number[], typicalGap: number): number {
  if (typicalGap <= 0) return 0;

  const deviations = gaps.map((gap) => Math.abs(gap - typicalGap) / typicalGap);

  return clamp01(1 - median(deviations));
}

/**
 * How stable the amounts are, as 0–1. This is what separates a bill from a habit.
 *
 * Computed in floating point on purpose, and it is not a money calculation: it is a ratio used to
 * classify, and it never becomes a figure shown to anyone. Every amount that *is* reported comes
 * from `medianAmount`, which returns a value that actually occurred.
 */
function amountStability(ordered: readonly RecurringInput[]): number {
  const values = ordered.map((entry) => Number(entry.amountMinor));
  const typical = median(values);

  if (typical <= 0) return 0;

  const deviations = values.map((value) => Math.abs(value - typical) / typical);

  return clamp01(1 - median(deviations) * 2);
}

/**
 * Three occurrences is the minimum that can show a rhythm, and it is also the weakest evidence
 * there is. The weight rises with history and is capped, so a bill paid twenty times is not
 * treated as more certain than one paid ten.
 */
function occurrenceWeight(occurrences: number): number {
  return clamp01(0.4 + 0.1 * occurrences);
}

/** The median of the observed amounts — always a value some transaction actually had. */
function medianAmount(ordered: readonly RecurringInput[]): bigint {
  const sorted = [...ordered].map((entry) => entry.amountMinor).sort((a, b) => (a < b ? -1 : 1));

  // The lower of the two middles for an even count, rather than their mean: averaging would
  // produce a figure that never occurred, and this number is spoken as an expectation.
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0n;
}

/** The most recent narration, which is the one the user is likeliest to recognise. */
function label(ordered: readonly RecurringInput[]): string {
  const latest = ordered[ordered.length - 1]?.description.trim() ?? '';

  return latest === '' ? 'Unlabelled' : latest;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
