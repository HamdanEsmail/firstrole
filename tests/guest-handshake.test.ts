import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the actual Worker fetch handler without starting a Cloudflare
// Workflow or making any provider/network request.
vi.mock('../server/workflows', () => ({ SearchWorkflow: class {}, AgentWorkflow: class {} }));
vi.mock('../server/rates', () => ({ verifiedProviderEnv: vi.fn(async (env: unknown) => env) }));

import worker from '../server/index';
import { Database } from '../server/db';
import type { Env } from '../server/env';
import { DEFAULT_PREFERENCES, type SearchRun } from '../shared/types';
import { startSearch } from '../src/lib/api';

const origin = 'https://firstrole.example.com';
const preferences = { ...DEFAULT_PREFERENCES, role: 'Graduate analyst', location: 'United States' };

function environment(): Env {
  return {
    ASSETS: { fetch: vi.fn() },
    SEARCH_WORKFLOW: { createBatch: vi.fn().mockResolvedValue([]) },
    AGENT_WORKFLOW: { createBatch: vi.fn().mockResolvedValue([]) },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test-public',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server',
    GUEST_COOKIE_SECRET: 'test-only-signing-secret-at-least-32-characters',
    TINYFISH_ENABLED: 'true',
    TINYFISH_API_KEY: 'test-only-provider-key',
    APP_ORIGIN: origin,
  } as unknown as Env;
}

function searchRequest(cookie?: string): Request {
  return new Request(`${origin}/api/searches`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': 'same-first-guest-search-operation',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ preferences }),
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('guest handshake before search admission', () => {
  it('sets a signed config cookie without Auth, database, or provider requests', async () => {
    const env = environment();
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const database = vi.spyOn(Database.prototype, 'rpc');
    const response = await worker.fetch(
      new Request(`${origin}/api/config`, {
        headers: { authorization: 'Bearer expired-test-token' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('firstrole_guest=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const repeated = await worker.fetch(
      new Request(`${origin}/api/config`, { headers: { cookie } }),
      env,
    );
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get('set-cookie')).toBeNull();
    expect(database).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('keeps unconfigured config available without a cookie-signing secret', async () => {
    const env = { ...environment(), GUEST_COOKIE_SECRET: undefined };
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await worker.fetch(new Request(`${origin}/api/config`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toMatchObject({ searchEnabled: false, googleEnabled: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('never admits a search when the first cookie response is lost', async () => {
    const env = environment();
    const database = vi.spyOn(Database.prototype, 'rpc');
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    // The first response is deliberately discarded without keeping Set-Cookie.
    const lost = await worker.fetch(searchRequest(), env);
    const retry = await worker.fetch(searchRequest(), env);
    expect(lost.status).toBe(425);
    expect(retry.status).toBe(425);
    expect(await retry.json()).toMatchObject({ error: { code: 'GUEST_SESSION_READY' } });
    expect(retry.headers.get('set-cookie')).toContain('firstrole_guest=');
    expect(database).not.toHaveBeenCalled();
    expect(env.SEARCH_WORKFLOW.createBatch).not.toHaveBeenCalled();
    expect(env.AGENT_WORKFLOW.createBatch).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('does not admit a search from a tampered cookie', async () => {
    const env = environment();
    const database = vi.spyOn(Database.prototype, 'rpc');
    const response = await worker.fetch(
      searchRequest('firstrole_guest=forged.identity.signature'),
      env,
    );
    expect(response.status).toBe(425);
    expect(await response.json()).toMatchObject({ error: { code: 'GUEST_SESSION_READY' } });
    expect(database).not.toHaveBeenCalled();
    expect(env.SEARCH_WORKFLOW.createBatch).not.toHaveBeenCalled();
  });

  it('stops after one handshake retry when the browser blocks cookies, with no database work', async () => {
    const env = environment();
    const database = vi.spyOn(Database.prototype, 'rpc');
    const keys: string[] = [];
    const browser = vi.fn(async (path: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      headers.set('origin', origin);
      keys.push(headers.get('idempotency-key')!);
      // Simulate a browser that refuses every Set-Cookie response.
      return worker.fetch(new Request(`${origin}${path}`, { ...options, headers }), env);
    });
    vi.stubGlobal('fetch', browser);
    await expect(
      startSearch({ ...preferences, role: 'Blocked-cookie test' }),
    ).rejects.toMatchObject({
      status: 425,
      code: 'GUEST_COOKIES_REQUIRED',
      message: expect.stringContaining('No search was started'),
    });
    expect(browser).toHaveBeenCalledTimes(2);
    expect(new Set(keys).size).toBe(1);
    expect(database).not.toHaveBeenCalled();
    expect(env.SEARCH_WORKFLOW.createBatch).not.toHaveBeenCalled();
  });

  it('retains one actor and idempotency key when an admitted response is lost after the handshake', async () => {
    const env = environment();
    const runs = new Map<string, SearchRun>();
    const admissions: string[] = [];
    const durableRuns = new Set<string>();
    vi.mocked(env.SEARCH_WORKFLOW.createBatch).mockImplementation(async (batch) => {
      for (const item of batch) durableRuns.add(item.id!);
      return [];
    });
    vi.spyOn(Database.prototype, 'rpc').mockImplementation(async (name, args) => {
      if (name === 'get_search_cache') return null;
      if (name === 'create_search_run') {
        const identity = `${args.p_actor_key}:${args.p_idempotency_key}`;
        admissions.push(identity);
        const previous = runs.get(identity);
        if (previous) return { admitted: true, run: previous, reused: true };
        const run = args.p_payload as SearchRun;
        runs.set(identity, run);
        return { admitted: true, run, reused: false };
      }
      throw new Error('Unexpected database call');
    });
    let cookie = '';
    let dropped = false;
    const keys: string[] = [];
    const browser = vi.fn(async (path: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      headers.set('origin', origin);
      if (cookie) headers.set('cookie', cookie);
      keys.push(headers.get('idempotency-key')!);
      const response = await worker.fetch(
        new Request(`${origin}${path}`, { ...options, headers }),
        env,
      );
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      if (response.status === 202 && !dropped) {
        dropped = true;
        throw new TypeError('Response lost after admission');
      }
      return response;
    });
    vi.stubGlobal('fetch', browser);
    const input = { ...preferences, role: 'Lost-admitted-response test' };
    await expect(startSearch(input)).rejects.toMatchObject({ code: 'offline' });
    const resumed = await startSearch(input);
    expect(resumed.status).toBe('queued');
    expect(browser).toHaveBeenCalledTimes(3);
    expect(new Set(keys).size).toBe(1);
    expect(new Set(admissions).size).toBe(1);
    expect(runs.size).toBe(1);
    expect(durableRuns.size).toBe(1);
    expect(env.AGENT_WORKFLOW.createBatch).not.toHaveBeenCalled();
  });
});
