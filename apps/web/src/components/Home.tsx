import { greeting } from '../lib/format';

/**
 * The resting state: who you are, and the fastest ways in.
 *
 * The prompts are concrete questions rather than feature names. "Voice Assistant" tells someone
 * what the app is; "What did I spend on food this month?" tells them what it can answer — and the
 * second is what makes a blank assistant usable in the first ten seconds.
 */

const QUICK_PROMPTS: readonly { readonly glyph: string; readonly text: string }[] = [
  { glyph: '◆', text: 'How much did I spend this month?' },
  { glyph: '▲', text: 'What came in this month?' },
  { glyph: '●', text: 'Where is my money going?' },
  { glyph: '◇', text: 'Compare this week against last week' },
];

export function Home({
  onAsk,
  disabled,
}: {
  onAsk: (question: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <>
      <h1 className="headline">
        Talk about <em>your money</em>
      </h1>

      <p style={{ margin: '0 2px 6px', color: 'var(--text-dim)', fontSize: 15 }}>
        {greeting(new Date())}. Ask anything — every figure comes from your own ledger.
      </p>

      <div className="section-label">
        <span>Try asking</span>
      </div>

      <div className="chips">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            className="chip"
            key={prompt.text}
            onClick={() => onAsk(prompt.text)}
            disabled={disabled}
          >
            <span className="chip-glyph" aria-hidden="true">
              {prompt.glyph}
            </span>
            <span className="chip-text">{prompt.text}</span>
          </button>
        ))}
      </div>
    </>
  );
}
