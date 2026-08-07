import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Home } from './components/Home';
import { CloseIcon, MicIcon, SendIcon, StopIcon } from './components/Icons';
import { Setup } from './components/Setup';
import { useVoice } from './hooks/useVoice';
import { ApiError, type AskResponse, ask, type Credentials } from './lib/api';

/**
 * Atlas, on a phone.
 *
 * Voice-*forward*, not voice-only (ARCHITECTURE §8): the spoken answer is one sentence and the
 * canvas carries the evidence. Ears are bad at tables, so the assistant says the figure and shows
 * the working — the same thing a CFO does when they answer and slide the spreadsheet across.
 *
 * The one rule this file must not break: when the grounding gate suppresses an answer, show the
 * canvas and the notice, and **say nothing aloud**. Speaking an unverified figure about someone's
 * money is the failure the whole backend is built to prevent, and it would be undone here by a
 * single unconditional call to `speak`.
 */

const STORAGE_KEY = 'atlas.credentials.v1';

type Phase = 'idle' | 'thinking';

export function App(): React.JSX.Element {
  const [credentials, setCredentials] = useState<Credentials | null>(loadCredentials);
  const [phase, setPhase] = useState<Phase>('idle');
  const [question, setQuestion] = useState('');
  const [draft, setDraft] = useState('');
  const [turn, setTurn] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  const submit = useCallback(
    async (text: string, credentialsForTurn: Credentials): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === '') return;

      setQuestion(trimmed);
      setDraft('');
      setTurn(null);
      setError(null);
      setPhase('thinking');

      try {
        const response = await ask(credentialsForTurn, trimmed, sessionRef.current);
        sessionRef.current = response.sessionId;
        setTurn(response);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          // The token was revoked or replaced. Clearing it sends the user back to setup rather
          // than leaving them tapping a mic that will never work again.
          setCredentials(null);
          window.localStorage.removeItem(STORAGE_KEY);
          setError('This device is no longer authorised. Enrol it again.');
        } else {
          setError(cause instanceof Error ? cause.message : 'Something went wrong');
        }
      } finally {
        setPhase('idle');
      }
    },
    [],
  );

  const voice = useVoice(
    useCallback(
      (utterance: string) => {
        if (credentials !== null) void submit(utterance, credentials);
      },
      [credentials, submit],
    ),
  );

  // Speak only what the gate verified. `answer === null` means the model said something its tools
  // could not support, so there is deliberately nothing to say out loud.
  useEffect(() => {
    if (turn?.answer != null && turn.answer !== '') voice.speak(turn.answer);
  }, [turn, voice]);

  if (credentials === null) {
    return (
      <Shell>
        <Setup
          onReady={(next) => {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            setCredentials(next);
          }}
        />
      </Shell>
    );
  }

  const busy = phase === 'thinking';
  const showConversation = question !== '' || busy || turn !== null || error !== null;

  return (
    <Shell>
      <header className="header">
        <div className="avatar" aria-hidden="true">
          A
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="header-greeting">Atlas</div>
          <div className="header-name">Your money, on the record</div>
        </div>
        {showConversation && (
          <button
            className="icon-button"
            aria-label="Start over"
            onClick={() => {
              voice.cancelSpeech();
              sessionRef.current = null;
              setQuestion('');
              setTurn(null);
              setError(null);
            }}
          >
            <CloseIcon />
          </button>
        )}
      </header>

      {showConversation ? (
        <>
          <div className="orb-stage">
            <div
              className={`orb${voice.listening ? ' is-listening' : ''}${busy ? ' is-thinking' : ''}`}
              role="img"
              aria-label="Atlas"
            />
          </div>

          <div className="orb-status">
            {voice.listening
              ? voice.partial === ''
                ? 'Listening…'
                : voice.partial
              : busy
                ? 'Checking your ledger…'
                : question}
          </div>

          {error !== null && (
            <div className="error" style={{ marginTop: 16 }}>
              {error}
            </div>
          )}

          {turn !== null && (
            <>
              {turn.answer != null && turn.answer !== '' ? (
                <p className="answer glass">{turn.answer}</p>
              ) : (
                <p className="answer glass answer-suppressed">
                  I could not verify an answer to that against your ledger, so I have not given one.
                  The figures below are what your records actually show.
                </p>
              )}

              {turn.notice != null && turn.notice !== '' && (
                <div className="notice">
                  <span aria-hidden="true">⚠</span>
                  <span>{turn.notice}</span>
                </div>
              )}

              {turn.canvas !== null && <Canvas spec={turn.canvas} />}
            </>
          )}
        </>
      ) : (
        <Home onAsk={(text) => void submit(text, credentials)} disabled={busy} />
      )}

      <div className="spacer" />

      {voice.error !== null && (
        <div className="error" style={{ marginBottom: 10 }}>
          {voice.error}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft, credentials);
        }}
      >
        <input
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={voice.canListen ? 'Ask, or hold the mic' : 'Ask anything'}
          enterKeyHint="send"
          disabled={busy}
          aria-label="Your question"
        />
        <button
          type={draft.trim() === '' ? 'button' : 'submit'}
          className={`mic${voice.listening ? ' is-listening' : ''}`}
          disabled={busy || (draft.trim() === '' && !voice.canListen)}
          aria-label={
            draft.trim() !== '' ? 'Send' : voice.listening ? 'Stop listening' : 'Ask by voice'
          }
          onClick={() => {
            if (draft.trim() !== '') return;
            if (voice.listening) voice.stopListening();
            else voice.startListening();
          }}
        >
          {draft.trim() !== '' ? <SendIcon /> : voice.listening ? <StopIcon /> : <MicIcon />}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <div className="aurora" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <main className="shell">{children}</main>
    </>
  );
}

function loadCredentials(): Credentials | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;

    const parsed = JSON.parse(stored) as Partial<Credentials>;

    return typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string'
      ? { baseUrl: parsed.baseUrl, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}
