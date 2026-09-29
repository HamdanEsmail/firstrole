import type { Job, PublicConfig, SearchPreferences, SearchRun } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
const pendingStarts = new Map<string, string>();
const PENDING_STARTS_KEY = 'firstrole.pending-searches.v1';

async function request<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The service returned an unreadable response. Please try again.',
      );
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'request_failed',
        error?.message ?? 'The request could not be completed. Please try again.',
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new ApiError(
        0,
        'timeout',
        'The request took too long. Your search may still be running; retry to reconnect safely.',
      );
    throw new ApiError(
      0,
      'offline',
      'Could not reach FirstRole. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }
}
function readPending(key: string): string | undefined {
  if (pendingStarts.has(key)) return pendingStarts.get(key);
  try {
    const stored = JSON.parse(sessionStorage.getItem(PENDING_STARTS_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    if (typeof stored[key] === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(stored[key]))
      return stored[key];
  } catch {
    /* A memory-only idempotency key still protects this page's retries. */
  }
  return undefined;
}
function persistPending(key: string, id: string | null) {
  if (id) pendingStarts.set(key, id);
  else pendingStarts.delete(key);
  try {
    const stored = JSON.parse(sessionStorage.getItem(PENDING_STARTS_KEY) ?? '{}') as Record<
      string,
      string
    >;
    if (id) stored[key] = id;
    else delete stored[key];
    // Keep only a bounded set of in-flight starts; never persist authentication tokens.
    sessionStorage.setItem(
      PENDING_STARTS_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(stored).slice(-25))),
    );
  } catch {
    /* Storage failure cannot erase the in-memory reservation key. */
  }
}
export const getConfig = () => request<PublicConfig>('/api/config', null);
export const fetchConfig = getConfig;
export async function startSearch(
  preferences: SearchPreferences,
  token: string | null = null,
  forceRefresh = false,
  actorId = 'guest',
): Promise<SearchRun> {
  // Persist a digest, not the user's role, location, and keywords, for retry recovery.
  // actorId is only a local retry partition. The server independently verifies
  // the bearer token or signed guest cookie; no client identity is trusted.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ actorId, preferences, forceRefresh })),
  );
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  const id = readPending(key) ?? crypto.randomUUID();
  persistPending(key, id);
  const submit = () =>
    request<SearchRun>('/api/searches', token, {
      method: 'POST',
      headers: { 'Idempotency-Key': id },
      body: JSON.stringify({ preferences, forceRefresh }),
    });
  try {
    let result: SearchRun;
    try {
      result = await submit();
    } catch (error) {
      if (
        token ||
        !(error instanceof ApiError) ||
        error.status !== 425 ||
        error.code !== 'GUEST_SESSION_READY'
      )
        throw error;
      // This exact server response guarantees no run was admitted. The browser
      // has now received Set-Cookie; retry once with the same operation key.
      try {
        result = await submit();
      } catch (retryError) {
        if (
          retryError instanceof ApiError &&
          retryError.status === 425 &&
          retryError.code === 'GUEST_SESSION_READY'
        )
          throw new ApiError(
            425,
            'GUEST_COOKIES_REQUIRED',
            'Your browser could not keep the guest session. Allow cookies for FirstRole or sign in, then try again. No search was started.',
          );
        throw retryError;
      }
    }
    persistPending(key, null);
    return result;
  } catch (error) {
    // Keep the same key after an ambiguous network/server failure: do not create a second paid run.
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    )
      persistPending(key, null);
    throw error;
  }
}
export const getSearch = (id: string, token: string | null = null) =>
  request<SearchRun>(`/api/searches/${encodeURIComponent(id)}`, token);
export const cancelSearch = (id: string, token: string | null = null) =>
  request<SearchRun>(`/api/searches/${encodeURIComponent(id)}/cancel`, token, { method: 'POST' });
export const refreshJob = (id: string, token: string | null = null, searchId?: string) =>
  request<Job>(`/api/jobs/${encodeURIComponent(id)}/refresh`, token, {
    method: 'POST',
    body: JSON.stringify({ searchId }),
  });
export const deleteRemoteAccount = (token: string) =>
  request<{ ok: true }>('/api/account/delete', token, { method: 'POST' });
