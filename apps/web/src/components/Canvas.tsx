import type { CanvasSpec } from '../lib/api';
import { formatMoney } from '../lib/format';

/**
 * Renders evidence from a tool result.
 *
 * **Nothing here comes from the language model.** The canvas is built from the raw query payload
 * the server attached, which is the point of invariant I6: the spoken answer is a summary, and the
 * numbers on screen are the record. If the two ever disagree, the canvas is right.
 *
 * That is also why every branch degrades to showing the payload rather than hiding it. An
 * unrecognised canvas kind means the server knows something this build does not — showing the raw
 * figures is honest, whereas rendering nothing would quietly drop the evidence for a claim the
 * user just heard out loud.
 */

interface CanvasRow {
  readonly label: string;
  readonly value: string;
  readonly share?: number;
}

export function Canvas({ spec }: { spec: CanvasSpec }): React.JSX.Element {
  const currency = asString(spec.payload.currency) ?? 'NGN';
  const total = asString(spec.payload.total);
  const count = asNumber(spec.payload.count);
  const rows = readRows(spec.payload, currency);

  return (
    <section className="canvas glass" aria-label={spec.title}>
      <div className="canvas-title">{spec.title}</div>

      {total !== null && <div className="canvas-stat">{formatMoney(total, currency)}</div>}

      {count !== null && (
        <div className="canvas-stat-meta">
          {count === 1 ? '1 transaction' : `${count} transactions`}
        </div>
      )}

      {rows.length > 0 && (
        <div className="canvas-rows">
          {rows.map((row) => (
            <div className="canvas-row" key={`${row.label}-${row.value}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="canvas-row-label">{row.label}</div>
                {spec.kind === 'bar' && row.share !== undefined && (
                  <div className="canvas-bar-track">
                    <div
                      className="canvas-bar-fill"
                      style={{ width: `${Math.round(row.share * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="canvas-row-value">{row.value}</div>
            </div>
          ))}
        </div>
      )}

      {total === null && count === null && rows.length === 0 && (
        <pre
          className="provenance"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '10px 0 0' }}
        >
          {JSON.stringify(spec.payload, null, 2)}
        </pre>
      )}

      <div className="provenance">Straight from your ledger — not from the model.</div>
    </section>
  );
}

/**
 * Pulls displayable rows out of a payload without assuming a shape.
 *
 * The server's grouped results carry a `key` object and metric fields; a list carries
 * descriptions and amounts. Both are handled, and anything unrecognised yields no rows rather
 * than a guess — a mislabelled figure is worse than an absent one.
 */
function readRows(
  payload: Readonly<Record<string, unknown>>,
  currency: string,
): readonly CanvasRow[] {
  const raw = payload.rows;
  if (!Array.isArray(raw)) return [];

  const parsed: CanvasRow[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;

    const record = entry as Record<string, unknown>;
    const label = rowLabel(record);
    const amount = asString(record.total) ?? asString(record.amount);

    if (label === null || amount === null) continue;

    parsed.push({ label, value: formatMoney(amount, currency) });
  }

  // Shares are computed here, from the figures themselves, so a bar's length can never
  // disagree with the number printed beside it.
  const magnitudes = parsed.map((row) => Math.abs(Number(row.value.replace(/[^\d.]/g, ''))));
  const largest = Math.max(...magnitudes, 0);

  return largest > 0
    ? parsed.map((row, index) => ({ ...row, share: (magnitudes[index] ?? 0) / largest }))
    : parsed;
}

function rowLabel(record: Record<string, unknown>): string | null {
  const key = record.key;

  if (typeof key === 'object' && key !== null) {
    const values = Object.values(key as Record<string, unknown>)
      .map((value) => asString(value))
      .filter((value): value is string => value !== null);

    if (values.length > 0) return values.join(' · ');
  }

  return asString(record.label) ?? asString(record.description) ?? asString(record.name);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
