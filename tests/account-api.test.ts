import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../shared/types';
import { ApiError, getSearch, startSearch } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());
describe('API authentication and search retry safety', () => {
  it('uses HttpOnly guest cookies without sending a fabricated account identity', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'search-a' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSearch('search-a');
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.credentials).toBe('same-origin');
    expect(new Headers(options.headers).has('Authorization')).toBe(false);
    expect(new Headers(options.headers).has('X-Guest-Id')).toBe(false);
  });
  it('sends the current bearer token only in the authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'search-a' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSearch('search-a', 'test-token');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('test-token');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
  });
  it('reuses the idempotency key after a lost response and clears it after confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ id: 'search-retry' }), { status: 200 })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const preferences = { ...DEFAULT_PREFERENCES, role: 'retry-test-role' };
    await expect(startSearch(preferences)).rejects.toBeInstanceOf(ApiError);
    await startSearch(preferences);
    await startSearch(preferences);
    const ids = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get('Idempotency-Key'),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('preserves actionable server quota errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'budget_exhausted', message: 'The pilot allowance has been used.' },
          }),
          { status: 429 },
        ),
      ),
    );
    await expect(getSearch('search-a')).rejects.toMatchObject({
      status: 429,
      code: 'budget_exhausted',
      message: 'The pilot allowance has been used.',
    });
  });
  it('partitions ambiguous retries by account without putting tokens or preferences in browser storage', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connection lost'));
    vi.stubGlobal('fetch', fetchMock);
    const preferences = {
      ...DEFAULT_PREFERENCES,
      role: 'private-account-role',
      location: 'private-location',
    };
    await expect(startSearch(preferences, 'token-a', false, 'account-a')).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(startSearch(preferences, 'token-b', false, 'account-b')).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      startSearch(preferences, 'refreshed-token-a', false, 'account-a'),
    ).rejects.toBeInstanceOf(ApiError);
    const ids = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get('Idempotency-Key'),
    );
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
    const persisted = [...values.values()].join('');
    expect(persisted).not.toContain('private-account-role');
    expect(persisted).not.toContain('private-location');
    expect(persisted).not.toContain('token-a');
    expect(persisted).not.toContain('account-a');
  });
  it('retries the exact guest handshake once with the original key and request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'GUEST_SESSION_READY', message: 'Session ready' } }),
          { status: 425 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'handshake-search' }), { status: 202 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      startSearch({ ...DEFAULT_PREFERENCES, role: 'Client handshake test' }),
    ).resolves.toMatchObject({ id: 'handshake-search' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe(
      new Headers(second.headers).get('Idempotency-Key'),
    );
    expect(first.body).toBe(second.body);
  });
  it('does not automatically retry unrelated 425 errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'ANOTHER_CONDITION', message: 'Try later' } }),
          { status: 425 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      startSearch({ ...DEFAULT_PREFERENCES, role: 'Unrelated 425 test' }),
    ).rejects.toMatchObject({ code: 'ANOTHER_CONDITION' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not treat a handshake code under a different status as retry permission', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'GUEST_SESSION_READY', message: 'Unexpected status' } }),
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      startSearch({ ...DEFAULT_PREFERENCES, role: 'Wrong-status handshake test' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
