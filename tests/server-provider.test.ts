import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../server/env';
import { providerReady } from '../server/env';
import { Database } from '../server/db';
import { TinyFish } from '../server/tinyfish';

function env(): Env {
  return {
    ASSETS: {} as Fetcher,
    SEARCH_WORKFLOW: {} as Env['SEARCH_WORKFLOW'],
    AGENT_WORKFLOW: {} as Env['AGENT_WORKFLOW'],
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test-public',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server',
    GUEST_COOKIE_SECRET: 'test-secret-value-at-least-32-characters',
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_ENABLED: 'true',
    TINYFISH_RATES_VERIFIED_AT: new Date().toISOString(),
    TINYFISH_AGENT_RATE: '0.016',
    TINYFISH_SEARCH_RATE: '0.005',
    TINYFISH_FETCH_RATE: '0.001',
  };
}
function database() {
  return {
    reserve: vi.fn().mockResolvedValue({ allowed: true, operationId: 'op-1' }),
    claim: vi.fn().mockResolvedValue({ claimed: true, state: 'claimed' }),
    bind: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(undefined),
    rejectBeforeStart: vi.fn().mockResolvedValue(undefined),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('provider admission and duplicate protection', () => {
  it('fails closed on stale or elevated provider rates', () => {
    expect(providerReady(env())).toBe(true);
    expect(providerReady({ ...env(), TINYFISH_RATES_VERIFIED_AT: '2020-01-01T00:00:00Z' })).toBe(
      false,
    );
    expect(providerReady({ ...env(), TINYFISH_AGENT_RATE: '0.02' })).toBe(false);
    expect(providerReady({ ...env(), TINYFISH_FETCH_RATE: undefined })).toBe(false);
  });
  it('does not contact a provider when budget admission is rejected', async () => {
    const db = database();
    db.reserve.mockResolvedValue({ allowed: false, reason: 'budget_exhausted' });
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    await expect(
      new TinyFish(env(), db as unknown as Database, 'search-1').search('analyst', 's1'),
    ).rejects.toMatchObject({ status: 429 });
    expect(outbound).not.toHaveBeenCalled();
  });
  it('retains an uncertain Agent reservation and never retries the POST', async () => {
    const db = database();
    const outbound = vi.fn().mockRejectedValue(new Error('network lost'));
    vi.stubGlobal('fetch', outbound);
    const api = new TinyFish(env(), db as unknown as Database, 'search-1');
    await expect(
      api.startAgent('https://careers.example.com/jobs', 'Read jobs', {}, 'a1'),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(db.settle).toHaveBeenCalledWith('op-1', expect.any(String), 'unknown');
    db.claim.mockResolvedValue({ claimed: false, state: 'needs_reconciliation' });
    await expect(
      api.startAgent('https://careers.example.com/jobs', 'Read jobs', {}, 'a1'),
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
    expect(outbound).toHaveBeenCalledTimes(1);
  });
  it('resumes a bound Agent operation without a new provider POST', async () => {
    const db = database();
    db.claim.mockResolvedValue({
      claimed: false,
      state: 'claimed',
      providerRunId: 'run-existing',
      claimToken: 'original-token',
    });
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const result = await new TinyFish(env(), db as unknown as Database, 's1').startAgent(
      'https://careers.example.com/jobs',
      'Read jobs',
      {},
      'a1',
    );
    expect(result).toEqual({
      operationId: 'op-1',
      claimToken: 'original-token',
      runId: 'run-existing',
    });
    expect(outbound).not.toHaveBeenCalled();
  });
  it('only recognizes the explicit pre-execution schema entitlement rejection', async () => {
    const db = database();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'output_schema capability not enabled for this account' },
          }),
          { status: 403 },
        ),
      ),
    );
    await expect(
      new TinyFish(env(), db as unknown as Database, 's1').startAgent(
        'https://careers.example.com/jobs',
        'Read jobs',
        {},
        'a1',
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_ENTITLEMENT' });
    expect(db.rejectBeforeStart).toHaveBeenCalledOnce();
    expect(db.settle).not.toHaveBeenCalled();
  });
  it('does not treat a generic 403 as safe to resubmit', async () => {
    const db = database();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 }),
        ),
    );
    await expect(
      new TinyFish(env(), db as unknown as Database, 's1').startAgent(
        'https://careers.example.com/jobs',
        'Read jobs',
        {},
        'a1',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ACCESS' });
    expect(db.rejectBeforeStart).not.toHaveBeenCalled();
    expect(db.settle).toHaveBeenCalledWith('op-1', expect.any(String), 'unknown');
  });
  it('sends a live Fetch and treats removal as closed-source evidence', async () => {
    const db = database();
    const outbound = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [], errors: [{ error: 'page_not_found' }] })),
      );
    vi.stubGlobal('fetch', outbound);
    await expect(
      new TinyFish(env(), db as unknown as Database, 's1').fetchPage(
        'https://careers.example.com/jobs/123',
        'f1',
      ),
    ).rejects.toMatchObject({ code: 'LISTING_REMOVED', status: 410 });
    expect(JSON.parse(outbound.mock.calls[0][1].body)).toMatchObject({
      ttl: 0,
      urls: ['https://careers.example.com/jobs/123'],
    });
    expect(db.settle).toHaveBeenCalledTimes(1);
    expect(outbound.mock.calls[0][1].redirect).toBe('manual');
  });
  it('does not repeat a settlement request after a storage failure', async () => {
    const db = database();
    db.settle.mockRejectedValue(new Error('storage unavailable'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }))),
    );
    await expect(
      new TinyFish(env(), db as unknown as Database, 's1').search('software intern', 's1'),
    ).rejects.toThrow();
    expect(db.settle).toHaveBeenCalledTimes(1);
  });
  it('uses workerd-supported manual redirects and rejects 3xx without forwarding credentials', async () => {
    const db = database();
    const outbound = vi
      .fn()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://unrelated.example/collect' },
        }),
      );
    vi.stubGlobal('fetch', outbound);
    await expect(
      new TinyFish(env(), db as unknown as Database, 's1').search('software intern', 's1'),
    ).rejects.toMatchObject({ code: 'PROVIDER_REDIRECT', status: 502 });
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound.mock.calls[0][0]).toContain('https://api.search.tinyfish.ai');
    expect(outbound.mock.calls[0][1].redirect).toBe('manual');
  });
});
