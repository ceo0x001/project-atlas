/**
 * Atlas API client.
 *
 * Mirrors the server contracts by hand rather than sharing types across the boundary. That is
 * deliberate: the API is versioned (`/v1`) and a client that compiles against the server's
 * internal types would silently follow a breaking change instead of failing at the seam.
 */

export interface CanvasSpec {
  readonly kind: 'table' | 'bar' | 'line' | 'list' | 'stat';
  readonly title: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AskResponse {
  readonly sessionId: string;
  readonly turnId: string;
  /**
   * Null when the grounding gate suppressed the prose — the model said something its tools could
   * not support. The client MUST render the canvas and notice instead of an empty bubble
   * (invariant I1): silence with evidence beats a confident sentence with none.
   */
  readonly answer: string | null;
  readonly canvas: CanvasSpec | null;
  readonly notice?: string;
  readonly grounding: string;
  readonly latencyMs: number;
}

export interface AccountBalance {
  readonly accountId: string;
  readonly label: string;
  readonly currency: string;
  readonly balanceMinor: string | null;
  readonly asOf: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Credentials {
  readonly baseUrl: string;
  readonly token: string;
}

async function request<T>(
  credentials: Credentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${credentials.baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { message?: unknown }) => String(body.message ?? response.statusText))
      .catch(() => response.statusText);

    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

export function ask(
  credentials: Credentials,
  question: string,
  sessionId: string | null,
): Promise<AskResponse> {
  return request<AskResponse>(credentials, '/v1/chat', {
    method: 'POST',
    body: JSON.stringify(sessionId === null ? { question } : { question, sessionId }),
  });
}

/**
 * Cheap authenticated call used to validate a token during setup.
 *
 * Deliberately not `/v1/chat`: verifying a credential should not cost a model call, and a
 * question sent before the user has asked one would appear in their history.
 */
export function verifyCredentials(credentials: Credentials): Promise<unknown> {
  return request(credentials, '/v1/sync/capabilities', { method: 'POST' });
}
