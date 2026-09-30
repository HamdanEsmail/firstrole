import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../server/env';
import { providerReady } from '../server/env';
import { Database, admissionError } from '../server/db';
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
  const reserve = vi.fn().mockResolvedValue({ allowed: true, operationId: 'op-1' });
  return {
    reserve,
    reserveBoundedAgent: vi.fn((runId: string, key: string, host: string) =>
      reserve(runId, key, 'agent', 1, host),
    ),
    claim: vi.fn().mockResolvedValue({ claimed: true, state: 'claimed' }),
    bind: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(undefined),
    rejectBeforeStart: vi.fn().mockResolvedValue(undefined),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provider admission and duplicate protection', () => {
  it('reconciles validated reported usage without changing supported SQL outcome labels', async () => {
    const db = new Database(env());
    const rpc = vi.spyOn(db, 'rpc').mockResolvedValue({ settled: true });
    await db.settle('op', 'claim', 'completed', true, 0.064);
    expect(rpc).toHaveBeenLastCalledWith('settle_provider_operation', {
      p_operation_id: 'op',
      p_claim_token: 'claim',
      p_outcome: 'completed',
      p_actual_usd: 0.064,
      p_authoritative: true,
      p_terminal_verified: true,
    });
    await db.settle('op', 'claim', 'cancelled', true, 0);
    expect(rpc).toHaveBeenLastCalledWith(
      'settle_provider_operation',
      expect.objectContaining({
        p_outcome: 'cancelled',
        p_actual_usd: 0,
        p_authoritative: true,
      }),
    );
    await db.settle('op', 'claim', 'completed', true);
    expect(rpc).toHaveBeenLastCalledWith(
      'settle_provider_operation',
      expect.objectContaining({
        p_outcome: 'completed',
        p_actual_usd: null,
        p_authoritative: false,
      }),
    );
    await db.settle('op', 'claim', 'unknown', false, 0.064);
    expect(rpc).toHaveBeenLastCalledWith(
      'settle_provider_operation',
      expect.objectContaining({ p_actual_usd: null, p_authoritative: false }),
    );
  });
  it('does not treat a rejected accounting RPC as a successful release', async () => {
    const db = new Database(env());
    const rpc = vi
      .spyOn(db, 'rpc')
      .mockResolvedValue({ settled: false, reason: 'invalid_outcome' });
    await expect(db.settle('op', 'claim', 'completed', true, 0.064)).rejects.toMatchObject({
      code: 'ACCOUNTING_UNCONFIRMED',
    });
    rpc.mockResolvedValue({ settled: false, state: 'needs_reconciliation' });
    await expect(db.settle('op', 'claim', 'completed', true)).resolves.toBeUndefined();
    await expect(db.settle('op', 'claim', 'completed', true, 0.064)).rejects.toMatchObject({
      code: 'ACCOUNTING_UNCONFIRMED',
    });
    await expect(db.rejectBeforeStart('op', 'claim')).rejects.toMatchObject({
      code: 'ACCOUNTING_UNCONFIRMED',
    });
  });
  it.each([
    { run_id: 'foreign-run', status: 'COMPLETED', num_of_steps: 0 },
    { status: 'COMPLETED', num_of_steps: 0 },
    { run_id: 'expected-run', status: 'INVALID' },
  ])(
    'rejects malformed or mismatched provider run observations before lifecycle use',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      await expect(
        new TinyFish(env(), database() as unknown as Database, 'search-1').getRun('expected-run'),
      ).rejects.toMatchObject({ code: 'INVALID_RUN_RESPONSE' });
    },
  );
  it('uses the same exact step ceiling and reservation in the bounded RPC and provider payload', async () => {
    const actualDb = new Database(env());
    const rpc = vi
      .spyOn(actualDb, 'rpc')
      .mockResolvedValue({ allowed: true, operationId: 'bounded' });
    await actualDb.reserveBoundedAgent('search-1', 'agent-1', 'careers.example.com');
    expect(rpc).toHaveBeenCalledWith('reserve_bounded_agent_operation', {
      p_run_id: 'search-1',
      p_operation_key: 'agent-1',
      p_source_host: 'careers.example.com',
      p_max_steps: 20,
      p_reservation_usd: 0.35,
    });
    const db = database();
    db.reserveBoundedAgent.mockResolvedValue({ allowed: true, operationId: 'bounded' });
    const outbound = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ run_id: 'run-bounded' })));
    vi.stubGlobal('fetch', outbound);
    await new TinyFish(env(), db as unknown as Database, 'search-1').startAgent(
      'https://careers.example.com/jobs',
      'Read one',
      {},
      'agent-1',
      false,
    );
    expect(db.reserveBoundedAgent).toHaveBeenCalledOnce();
    expect(db.reserve).not.toHaveBeenCalled();
    const body = JSON.parse(outbound.mock.calls[0][1].body);
    expect(body.agent_config).toEqual({ max_steps: 20, max_duration_seconds: 120 });
    expect(body.output_schema).toBeUndefined();
  });
  it('omits a beta-gated step limit only behind the separate legacy reservation path', async () => {
    const db = database();
    const outbound = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ run_id: 'run-legacy' })));
    vi.stubGlobal('fetch', outbound);
    await new TinyFish(env(), db as unknown as Database, 'search-1').startAgent(
      'https://careers.example.com/jobs',
      'Read one',
      {},
      'agent-legacy',
      false,
      'legacy',
    );
    expect(db.reserveBoundedAgent).not.toHaveBeenCalled();
    expect(db.reserve).toHaveBeenCalledWith(
      'search-1',
      'agent-legacy',
      'agent',
      1,
      'careers.example.com',
    );
    expect(JSON.parse(outbound.mock.calls[0][1].body).agent_config).toEqual({
      max_duration_seconds: 120,
    });
  });
  it.each([
    { error: { message: 'agent_config.max_steps requires beta access' } },
    { message: 'agent_config.max_steps requires beta access' },
  ])(
    'recognizes a conclusive max_steps rejection in supported error envelopes: %j',
    async (payload) => {
      const db = database();
      const outbound = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(payload), { status: 403 }));
      vi.stubGlobal('fetch', outbound);
      await expect(
        new TinyFish(env(), db as unknown as Database, 'search-1').startAgent(
          'https://careers.example.com/jobs',
          'Read one',
          {},
          'bounded',
          false,
        ),
      ).rejects.toMatchObject({ code: 'STEP_LIMIT_ENTITLEMENT' });
      expect(db.rejectBeforeStart).toHaveBeenCalledOnce();
      expect(db.settle).not.toHaveBeenCalled();
      expect(outbound).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { message: 'agent_config.max_steps requires beta access', run_id: 'possibly-started' },
    { message: 'agent_config.max_steps requires beta access', runId: 'possibly-started' },
    {
      error: { message: 'agent_config.max_steps requires beta access', run_id: 'possibly-started' },
    },
    { error: { message: 'Forbidden' }, message: 'agent_config.max_steps requires beta access' },
    { error: { message: 'Forbidden' }, request: { goal: 'max_steps beta access' } },
  ])(
    'does not release a denied start using ambiguous or echoed capability evidence: %j',
    async (payload) => {
      const db = database();
      const outbound = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(payload), { status: 403 }));
      vi.stubGlobal('fetch', outbound);
      await expect(
        new TinyFish(env(), db as unknown as Database, 'search-1').startAgent(
          'https://careers.example.com/jobs',
          'Read one',
          {},
          'bounded',
          false,
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_ACCESS' });
      expect(db.rejectBeforeStart).not.toHaveBeenCalled();
      expect(db.settle).toHaveBeenCalled();
      expect(outbound).toHaveBeenCalledOnce();
    },
  );
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
  it('scopes an unaffordable Agent reservation without claiming the whole pilot is exhausted', async () => {
    const db = database();
    db.reserve.mockResolvedValue({ allowed: false, reason: 'budget_exhausted' });
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    await expect(
      new TinyFish(env(), db as unknown as Database, 'search-1').startAgent(
        'https://careers.example.com/jobs',
        'Read one opening',
        {},
        'agent-1',
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_BUDGET_LIMIT',
      status: 429,
      message:
        'This browser-assisted check is unavailable within the pilot allowance. Any basic search results are preserved. No payment is needed.',
    });
    expect(db.reserve).toHaveBeenCalledTimes(1);
    expect(db.reserve).toHaveBeenCalledWith(
      'search-1',
      'agent-1',
      'agent',
      1,
      'careers.example.com',
    );
    expect(db.claim).not.toHaveBeenCalled();
    expect(db.bind).not.toHaveBeenCalled();
    expect(db.settle).not.toHaveBeenCalled();
    expect(db.rejectBeforeStart).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each(['search', 'fetch'] as const)(
    'keeps a real %s budget denial distinct from the Agent limit',
    async (kind) => {
      const db = database();
      db.reserve.mockResolvedValue({ allowed: false, reason: 'budget_exhausted' });
      const outbound = vi.fn();
      vi.stubGlobal('fetch', outbound);
      const api = new TinyFish(env(), db as unknown as Database, 'search-1');
      const request =
        kind === 'search'
          ? api.search('engineering intern', 'search-1')
          : api.fetchPage('https://careers.example.com/jobs/123', 'fetch-1');
      await expect(request).rejects.toMatchObject({
        code: 'BUDGET_EXHAUSTED',
        status: 429,
        message:
          'The public pilot has reached its spending limit. Saved and cached results are still available.',
      });
      expect(outbound).not.toHaveBeenCalled();
      expect(db.claim).not.toHaveBeenCalled();
      expect(db.settle).not.toHaveBeenCalled();
    },
  );
  it('preserves ordinary API admission and unrelated Agent denial reasons', () => {
    expect(admissionError('budget_exhausted').code).toBe('BUDGET_EXHAUSTED');
    expect(admissionError('budget_exhausted').message).toContain('spending limit');
    expect(admissionError('global_agent_daily_limit', 'agent').code).toBe(
      'GLOBAL_AGENT_DAILY_LIMIT',
    );
    expect(admissionError('global_agent_daily_limit', 'agent').message).toContain('used today');
  });
  it('does not disable direct Search and Fetch after a larger Agent reservation is denied', async () => {
    const db = database();
    db.reserve.mockImplementation(async (_run, _key, kind) =>
      kind === 'agent'
        ? { allowed: false, reason: 'budget_exhausted' }
        : { allowed: true, operationId: `operation-${kind}` },
    );
    const url = 'https://careers.example.com/jobs/123';
    const page = { url, text: '# Engineering Intern\nApply now' };
    const outbound = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ title: 'Engineering Intern', url }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [page] })));
    vi.stubGlobal('fetch', outbound);
    const api = new TinyFish(env(), db as unknown as Database, 'search-1');
    await expect(api.startAgent(url, 'Read one opening', {}, 'agent-1')).rejects.toMatchObject({
      code: 'AGENT_BUDGET_LIMIT',
    });
    expect(await api.search('engineering intern', 'search-1')).toHaveLength(1);
    expect(await api.fetchPage(url, 'fetch-1')).toEqual(page);
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(
      outbound.mock.calls.every(([target]) => !String(target).includes('agent.tinyfish.ai')),
    ).toBe(true);
    expect(db.claim).toHaveBeenCalledTimes(2);
    expect(db.settle).toHaveBeenCalledTimes(2);
    expect(db.rejectBeforeStart).not.toHaveBeenCalled();
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
    const outbound = vi.fn().mockResolvedValue(
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
