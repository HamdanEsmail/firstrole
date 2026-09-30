import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/workflows', () => ({ SearchWorkflow: class {}, AgentWorkflow: class {} }));
vi.mock('../server/enrichment-workflow', () => ({ EnrichmentWorkflow: class {} }));
vi.mock('../server/rates', () => ({ verifiedProviderEnv: vi.fn(async (env: unknown) => env) }));

import type { Job, SearchPreferences, SearchRun } from '../shared/types';
import { Database } from '../server/db';
import type { Env } from '../server/env';
import { applyLatestJobFacts, hydrateTerminalSearch } from '../server/freshness';
import worker from '../server/index';
import { verifiedProviderEnv } from '../server/rates';

const origin = 'https://firstrole.example.com';
const oldCheck = '2026-09-29T10:00:00.000Z';
const newCheck = '2026-09-30T10:00:00.000Z';
const preferences: SearchPreferences = {
  role: 'Data analyst',
  location: 'Dubai',
  keywords: 'SQL',
  jobTypes: ['internship', 'entry-level'],
  workplaces: [],
  sponsorshipRequired: false,
  postedWithinDays: null,
};

function job(changes: Partial<Job> = {}): Job {
  return {
    id: 'a'.repeat(64),
    title: 'Junior Data Analyst',
    company: 'Example',
    location: 'Dubai',
    workplace: 'onsite',
    remoteRegion: null,
    employmentType: 'entry-level',
    sourceUrl: 'https://careers.example.com/jobs/123',
    applyUrl: 'https://careers.example.com/jobs/123/apply',
    requisitionId: '123',
    description: 'Analyze business data using SQL.',
    requirements: ['SQL'],
    salary: null,
    postedAt: null,
    deadline: null,
    checkedAt: oldCheck,
    sponsorship: 'not-stated',
    evidence: [
      {
        field: 'title',
        text: 'Junior Data Analyst',
        sourceUrl: 'https://careers.example.com/jobs/123',
      },
    ],
    availability: 'open',
    match: { tier: 'Possible match', reasons: ['Stale unrelated search reason'], score: 1 },
    ...changes,
  };
}

function run(changes: Partial<SearchRun> = {}): SearchRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    stage: 'Your shortlist is ready.',
    preferences: structuredClone(preferences),
    results: [job()],
    cached: false,
    sources: [{ url: job().sourceUrl, name: 'Example', status: 'complete', count: 1 }],
    errors: [],
    createdAt: oldCheck,
    updatedAt: oldCheck,
    ...changes,
  };
}

function environment(): Env {
  return {
    ASSETS: { fetch: vi.fn() },
    SEARCH_WORKFLOW: { createBatch: vi.fn() },
    AGENT_WORKFLOW: { createBatch: vi.fn() },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test-public',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server',
    GUEST_COOKIE_SECRET: 'test-only-freshness-signing-secret-long-value',
    TINYFISH_ENABLED: 'true',
    TINYFISH_API_KEY: 'test-provider',
    APP_ORIGIN: origin,
  } as unknown as Env;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terminal search facts', () => {
  it('uses a newer check for availability, requirements and pay without importing another search rank', () => {
    const original = job();
    const updated = job({
      checkedAt: newCheck,
      availability: 'unverified',
      requirements: ['SQL', 'Bachelor degree'],
      salary: { text: 'USD 25 per hour', currency: 'USD', period: 'hour' },
      match: { tier: 'Strong match', reasons: ['Other account preference'], score: 999 },
    });
    const result = applyLatestJobFacts([original], [updated], preferences);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      checkedAt: newCheck,
      availability: 'unverified',
      requirements: updated.requirements,
      salary: updated.salary,
    });
    expect(result[0].match.tier).toBe('Possible match');
    expect(result[0].match.reasons).toContain('Opening status needs checking');
    expect(result[0].match.reasons).not.toContain('Other account preference');
    expect(original.checkedAt).toBe(oldCheck);
    expect(original.salary).toBeNull();
  });

  it.each([
    { availability: 'closed' as const },
    { location: 'London, United Kingdom' },
    { sponsorship: 'unavailable' as const },
  ])('removes a refreshed job that is now closed or incompatible: %j', (changed) => {
    const original = job({ sponsorship: 'available' });
    const updated = { ...original, checkedAt: newCheck, ...changed };
    expect(
      applyLatestJobFacts([original], [updated], { ...preferences, sponsorshipRequired: true }),
    ).toEqual([]);
  });

  it.each(['2026-09-28T10:00:00.000Z', oldCheck, 'invalid-date'])(
    'ignores catalog facts that are not strictly newer: %s',
    (checkedAt) => {
      const original = job();
      const result = applyLatestJobFacts(
        [original],
        [job({ checkedAt, availability: 'closed' })],
        preferences,
      );
      expect(result).toHaveLength(1);
      expect(result[0].availability).toBe('open');
      expect(result[0].checkedAt).toBe(oldCheck);
    },
  );

  it('recomputes and sorts matches using the current preferences', () => {
    const previousLeader = job({
      id: 'b'.repeat(64),
      description: 'Analyze business data.',
      requirements: [],
    });
    const changedRole = job({
      title: 'Junior Reporting Specialist',
      description: 'Prepare reports.',
      requirements: [],
    });
    const latest = job({ checkedAt: newCheck, description: 'SQL reporting for business data' });
    const ranked = applyLatestJobFacts([previousLeader, changedRole], [latest], preferences);
    expect(ranked.map((item) => item.id)).toEqual([latest.id, previousLeader.id]);
    expect(ranked[0].match.score).toBeGreaterThan(ranked[1].match.score);
    expect(ranked[0].match.reasons).toContain('Mentions sql');
    expect(ranked[0].match.reasons).not.toContain('Stale unrelated search reason');
  });

  it('retains run preferences and metadata, strips unrelated catalog fields, and never adds unrequested jobs', async () => {
    const original = run();
    const before = structuredClone(original);
    const foreign = {
      ...job({ checkedAt: newCheck }),
      preferences: { role: 'Other account role' },
      notes: 'Other note',
      user_id: 'other-owner',
    };
    const reader = {
      latestVerifiedJobs: vi
        .fn()
        .mockResolvedValue([foreign, job({ id: 'f'.repeat(64), checkedAt: newCheck })]),
    };
    const result = await hydrateTerminalSearch(original, reader);
    expect(original).toEqual(before);
    expect({ ...result, results: before.results }).toEqual(before);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).not.toHaveProperty('notes');
    expect(result.results[0]).not.toHaveProperty('preferences');
    expect(result.results[0]).not.toHaveProperty('user_id');
  });

  it('reads and presents no more than twelve original result IDs', async () => {
    const results = Array.from({ length: 16 }, (_, index) =>
      job({ id: index.toString(16).padStart(64, '0') }),
    );
    const reader = { latestVerifiedJobs: vi.fn().mockResolvedValue([]) };
    const result = await hydrateTerminalSearch(run({ results }), reader);
    expect(reader.latestVerifiedJobs).toHaveBeenCalledWith(
      results.slice(0, 12).map((item) => item.id),
    );
    expect(result.results).toHaveLength(12);
  });

  it('skips metadata reads for active searches and empty results', async () => {
    const reader = { latestVerifiedJobs: vi.fn() };
    const active = run({ status: 'extracting' });
    const empty = run({ results: [] });
    expect(await hydrateTerminalSearch(active, reader)).toBe(active);
    expect(await hydrateTerminalSearch(empty, reader)).toBe(empty);
    expect(reader.latestVerifiedJobs).not.toHaveBeenCalled();
  });

  it('does not silently serve an old snapshot when the current catalog cannot be read', async () => {
    const original = run();
    const reader = {
      latestVerifiedJobs: vi.fn().mockRejectedValue(new Error('Catalog temporarily unavailable')),
    };
    await expect(hydrateTerminalSearch(original, reader)).rejects.toThrow(
      'Catalog temporarily unavailable',
    );
    expect(original.results[0].checkedAt).toBe(oldCheck);
  });
});

describe('bounded catalog reads', () => {
  it('uses one service-only GET for at most twelve unique safe IDs and filters unexpected rows', async () => {
    const ids = Array.from({ length: 15 }, (_, index) => index.toString(16).padStart(64, '0'));
    const allowed = job({ id: ids[0], checkedAt: newCheck });
    const unexpected = job({ id: 'f'.repeat(64), checkedAt: newCheck });
    const outbound = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { job_id: allowed.id, job: allowed },
          { job_id: unexpected.id, job: unexpected },
        ]),
      ),
    );
    vi.stubGlobal('fetch', outbound);
    const result = await new Database(environment()).latestVerifiedJobs([
      ids[0],
      ...ids,
      'invalid),id.eq.injection',
    ]);
    expect(result).toEqual([allowed]);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [address, options] = outbound.mock.calls[0] as [URL, RequestInit];
    expect(address.pathname).toBe('/rest/v1/verified_jobs');
    expect(address.searchParams.get('job_id')).toBe(`in.(${ids.slice(0, 12).join(',')})`);
    expect(address.searchParams.get('limit')).toBe('12');
    expect(address.searchParams.get('select')).toBe('job_id,job');
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer test-server');
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.body).toBeUndefined();
    expect(options.redirect).toBe('manual');
  });

  it('does not make an unbounded request when no valid IDs are supplied', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    expect(await new Database(environment()).latestVerifiedJobs([])).toEqual([]);
    expect(await new Database(environment()).latestVerifiedJobs(['invalid-id'])).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe('HTTP freshness presentation', () => {
  async function cookie(env: Env) {
    const config = await worker.fetch(new Request(`${origin}/api/config`), env);
    return config.headers.get('set-cookie')!.split(';')[0];
  }

  it('hydrates an owned completed GET without updating private runs, saved records, or the cache', async () => {
    const env = environment();
    const sessionCookie = await cookie(env);
    const original = run();
    const rpc = vi.spyOn(Database.prototype, 'rpc').mockResolvedValue(original);
    const catalog = vi.spyOn(Database.prototype, 'latestVerifiedJobs').mockResolvedValue([
      job({
        checkedAt: newCheck,
        salary: { text: 'USD 25/hour', currency: 'USD', period: 'hour' },
      }),
    ]);
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${original.id}`, { headers: { cookie: sessionCookie } }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchRun;
    expect(body.results[0].checkedAt).toBe(newCheck);
    expect(body.results[0].salary?.text).toBe('USD 25/hour');
    expect(body.preferences).toEqual(original.preferences);
    expect(body.createdAt).toBe(oldCheck);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['get_search_run']);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(catalog.mock.invocationCallOrder[0]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('does not read the catalog for a search the caller cannot access', async () => {
    const env = environment();
    const sessionCookie = await cookie(env);
    vi.spyOn(Database.prototype, 'rpc').mockResolvedValue(null);
    const catalog = vi.spyOn(Database.prototype, 'latestVerifiedJobs');
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${run().id}`, { headers: { cookie: sessionCookie } }),
      env,
    );
    expect(response.status).toBe(404);
    expect(catalog).not.toHaveBeenCalled();
  });

  it('scopes old source-budget warnings without changing stored data or hiding whole-budget failures', async () => {
    const env = environment();
    const sessionCookie = await cookie(env);
    const legacy =
      'The public pilot has reached its spending limit. Saved and cached results are still available.';
    const original = run({
      status: 'partial',
      sources: [
        { url: job().sourceUrl, name: 'Example', status: 'failed', count: 0, message: legacy },
      ],
      errors: [
        { source: job().sourceUrl, message: legacy },
        { message: legacy },
        { source: 'https://example.org', message: 'Source unavailable.' },
      ],
    });
    const before = structuredClone(original);
    const rpc = vi.spyOn(Database.prototype, 'rpc').mockResolvedValue(original);
    vi.spyOn(Database.prototype, 'latestVerifiedJobs').mockResolvedValue([]);
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${original.id}`, {
        headers: { cookie: sessionCookie },
      }),
      env,
    );
    const body = (await response.json()) as SearchRun;
    expect(response.status).toBe(200);
    expect(body.errors[0].message).toContain('This source check was unavailable');
    expect(body.errors[0].message).toContain('No payment is needed');
    expect(body.sources[0].message).toBe(body.errors[0].message);
    expect(body.errors[1].message).toBe(legacy);
    expect(body.errors[2].message).toBe('Source unavailable.');
    expect(body.results.map(({ match: _match, ...facts }) => facts)).toEqual(
      original.results.map(({ match: _match, ...facts }) => facts),
    );
    expect(original).toEqual(before);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['get_search_run']);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('hydrates a cached POST after SQL returns the original cached payload, without extending its expiry or starting providers', async () => {
    const env = environment();
    const sessionCookie = await cookie(env);
    const cache = { results: [job()], sources: run().sources, errors: [] };
    const before = structuredClone(cache);
    const rpc = vi.spyOn(Database.prototype, 'rpc').mockImplementation(async (name, args) => {
      if (name === 'get_search_cache') return cache;
      if (name === 'create_search_run')
        return {
          admitted: true,
          run: { ...(args.p_payload as SearchRun), ...cache, cached: true },
          reused: false,
        };
      throw new Error('Unexpected mutation');
    });
    vi.spyOn(Database.prototype, 'latestVerifiedJobs').mockResolvedValue([
      job({
        checkedAt: newCheck,
        salary: { text: 'USD 25/hour', currency: 'USD', period: 'hour' },
      }),
    ]);
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await worker.fetch(
      new Request(`${origin}/api/searches`, {
        method: 'POST',
        headers: {
          origin,
          cookie: sessionCookie,
          'content-type': 'application/json',
          'idempotency-key': 'cached-freshness-test-operation',
        },
        body: JSON.stringify({ preferences }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchRun;
    expect(body.cached).toBe(true);
    expect(body.results[0].checkedAt).toBe(newCheck);
    expect(body.updatedAt).toBe(newCheck);
    expect(body.results[0].salary?.text).toBe('USD 25/hour');
    expect(cache).toEqual(before);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      'get_search_cache',
      'create_search_run',
    ]);
    expect(verifiedProviderEnv).not.toHaveBeenCalled();
    expect(env.SEARCH_WORKFLOW.createBatch).not.toHaveBeenCalled();
    expect(env.AGENT_WORKFLOW.createBatch).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
});
