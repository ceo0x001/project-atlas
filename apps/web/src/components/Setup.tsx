import { useState } from 'react';
import { type Credentials, verifyCredentials } from '../lib/api';

/**
 * First run: point the app at the API and give it a device token.
 *
 * There is no sign-in screen because there is no sign-in — Atlas v1 is single-user (ADR-009) and
 * devices are enrolled from the terminal. Pasting the token the CLI printed is the honest UI for
 * that, rather than a login form that pretends a password exists.
 *
 * The token is verified against a cheap endpoint before being stored, so a typo fails here rather
 * than as a mysterious 401 on the first question.
 */
export function Setup({
  onReady,
}: {
  onReady: (credentials: Credentials) => void;
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl());
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);

    const credentials: Credentials = { baseUrl: baseUrl.trim(), token: token.trim() };

    try {
      await verifyCredentials(credentials);
      onReady(credentials);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `${cause.message}. Check the address and that the API is running.`
          : 'Could not reach Atlas',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup glass">
      <h1>Connect Atlas</h1>
      <p>
        Enrol a device on the machine running the API, then paste the token it prints. It is shown
        once and never stored in readable form.
      </p>

      <div className="field">
        <label htmlFor="baseUrl">API address</label>
        <input
          id="baseUrl"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.0.10:3000"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
        />
      </div>

      <div className="field">
        <label htmlFor="token">Device token</label>
        <input
          id="token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="paste the token"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>

      {error !== null && <div className="error">{error}</div>}

      <button
        className="button-primary"
        onClick={() => void submit()}
        disabled={busy || token.trim() === '' || baseUrl.trim() === ''}
      >
        {busy ? 'Checking…' : 'Connect'}
      </button>

      <div className="hint">node dist/cli/enrol-device.js --phone 0801… --label "iPhone"</div>
    </div>
  );
}

/** Guesses the API on the same host during development, which is right most of the time. */
function defaultBaseUrl(): string {
  const { protocol, hostname } = window.location;

  return `${protocol}//${hostname}:3000`;
}
