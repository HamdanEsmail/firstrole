import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../server/db';
import { providerConfigured, providerReady, type Env } from '../server/env';
import { sha256 } from '../server/http';
import { parseWalletRates, verifiedProviderEnv, verifiedRateSnapshot } from '../server/rates';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const SIX_HOURS = 6 * 60 * 60 * 1000;
function env(): Env {
  return {
    ASSETS: {} as Fetcher,
    SEARCH_WORKFLOW: {} as Env['SEARCH_WORKFLOW'],
    AGENT_WORKFLOW: {} as Env['AGENT_WORKFLOW'],
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'public-test',
    SUPABASE_SERVICE_ROLE_KEY: 'private-test-key',
    GUEST_COOKIE_SECRET: 'private-cookie-secret',
    TINYFISH_API_KEY: 'private-tinyfish-test-key',
    TINYFISH_ENABLED: 'true',
    TINYFISH_RATES_VERIFIED_AT: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
    TINYFISH_AGENT_RATE: '0.016',
    TINYFISH_SEARCH_RATE: '0.005',
    TINYFISH_FETCH_RATE: '0.001',
  };
}
function wallet() {
  return {
    rates: {
      as_of: new Date(NOW - 1000).toISOString(),
      meters: [
        { label: 'TinyFish Agent', unit_amount: '0.016', currency: 'USD', per: 'step' },
        { label: 'TinyFish Search', unit_amount: '0.005', currency: 'USD', per: 'query' },
        { label: 'TinyFish Fetch', unit_amount: '0.001', currency: 'USD', per: 'url' },
        { label: 'TinyFish Browser', unit_amount: '0.002', currency: 'USD', per: 'minute' },
      ],
    },
  };
}
async function proof(overrides: Record<string, unknown> = {}) {
  return {
    state: 'verified',
    keyFingerprint: await sha256(env().TINYFISH_API_KEY!),
    providerAsOf: new Date(NOW - 1000).toISOString(),
    verifiedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW - 1000 + SIX_HOURS).toISOString(),
    agentRate: '0.016',
    searchRate: '0.005',
    fetchRate: '0.001',
    ...overrides,
  };
}
const database = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as Pick<Database, 'rpc'>;
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('official wallet meter contract', () => {
  it('accepts the exact three labels, units and USD rates and ignores other priced products', () => {
    expect(parseWalletRates(wallet(), NOW)).toEqual({
      providerAsOf: new Date(NOW - 1000).toISOString(),
      agentRate: '0.016',
      searchRate: '0.005',
      fetchRate: '0.001',
    });
  });
  it.each([
    [
      'Agent wrong unit',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].per = 'minute';
      },
    ],
    [
      'Search wrong currency',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[1].currency = 'EUR';
      },
    ],
    [
      'Fetch increased price',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[2].unit_amount = '0.0011';
      },
    ],
    [
      'unrecognized label',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].label = 'Agent';
      },
    ],
    [
      'missing product',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters.splice(1, 1);
      },
    ],
    [
      'duplicate product',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters.push({ ...w.rates.meters[0] });
      },
    ],
    [
      'future timestamp',
      (w: ReturnType<typeof wallet>) => {
        w.rates.as_of = new Date(NOW + 60_001).toISOString();
      },
    ],
    [
      'stale timestamp',
      (w: ReturnType<typeof wallet>) => {
        w.rates.as_of = new Date(NOW - SIX_HOURS).toISOString();
      },
    ],
    [
      'empty decimal',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].unit_amount = '';
      },
    ],
    [
      'negative decimal',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].unit_amount = '-0.001';
      },
    ],
    [
      'exponent decimal',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].unit_amount = '1e-3';
      },
    ],
    [
      'NaN decimal',
      (w: ReturnType<typeof wallet>) => {
        w.rates.meters[0].unit_amount = 'NaN';
      },
    ],
  ])('fails closed for %s', (_name, mutate) => {
    const value = wallet();
    mutate(value);
    expect(() => parseWalletRates(value, NOW)).toThrowError(
      expect.objectContaining({ code: 'RATES_UNVERIFIED' }),
    );
  });
  it.each([null, {}, { rates: null }, { rates: { meters: [], as_of: 'not a timestamp' } }])(
    'rejects unavailable/incomplete rates',
    (value) => {
      expect(() => parseWalletRates(value, NOW)).toThrow();
    },
  );
  it('accepts only bounded cross-service clock skew', () => {
    const value = wallet();
    value.rates.as_of = new Date(NOW + 45_000).toISOString();
    expect(parseWalletRates(value, NOW).providerAsOf).toBe(value.rates.as_of);
  });
});

describe('rate attestation preflight', () => {
  it('keeps public entry enabled when manual proof expires but paid providerReady remains false', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(providerConfigured(env())).toBe(true);
    expect(providerReady(env())).toBe(false);
    expect(providerConfigured({ ...env(), TINYFISH_ENABLED: 'false' })).toBe(false);
  });
  it('uses exactly one database read and no wallet call for fresh shared proof', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi.fn().mockResolvedValue(await proof());
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const verified = await verifiedProviderEnv(env(), database(rpc));
    expect(providerReady(verified)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(outbound).not.toHaveBeenCalled();
    expect(verified.TINYFISH_API_KEY).toBe(env().TINYFISH_API_KEY);
  });
  it('refreshes an expired proof using only fixed metadata GET and saves no raw secret', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: 'claimed' })
      .mockResolvedValueOnce(await proof());
    const outbound = vi.fn().mockResolvedValue(new Response(JSON.stringify(wallet())));
    vi.stubGlobal('fetch', outbound);
    const snapshot = await verifiedRateSnapshot(env(), database(rpc));
    expect(providerReady({ ...env(), ...snapshot })).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledWith(
      'https://agent.tinyfish.ai/v1/wallet',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: { 'X-API-Key': env().TINYFISH_API_KEY, Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(env().TINYFISH_API_KEY);
    expect(Object.keys(snapshot).sort()).toEqual([
      'TINYFISH_AGENT_RATE',
      'TINYFISH_FETCH_RATE',
      'TINYFISH_RATES_EXPIRES_AT',
      'TINYFISH_RATES_VERIFIED_AT',
      'TINYFISH_SEARCH_RATE',
    ]);
  });
  it('retains optional fresh manual proof only when bound to this exact API key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const configured = {
      ...env(),
      TINYFISH_RATES_VERIFIED_AT: new Date(NOW).toISOString(),
      TINYFISH_RATES_KEY_SHA256: await sha256(env().TINYFISH_API_KEY!),
    };
    const rpc = vi.fn().mockResolvedValue(null);
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const snapshot = await verifiedRateSnapshot(configured, database(rpc), { allowRefresh: false });
    expect(providerReady({ ...configured, ...snapshot })).toBe(true);
    await expect(
      verifiedRateSnapshot(
        { ...configured, TINYFISH_API_KEY: 'rotated-private-key' },
        database(rpc),
        { allowRefresh: false },
      ),
    ).rejects.toMatchObject({ code: 'RATES_UNVERIFIED' });
    expect(outbound).not.toHaveBeenCalled();
  });
  it('does not fall back to manual proof after a failed shared observation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const configured = {
      ...env(),
      TINYFISH_RATES_VERIFIED_AT: new Date(NOW).toISOString(),
      TINYFISH_RATES_KEY_SHA256: await sha256(env().TINYFISH_API_KEY!),
    };
    const rpc = vi.fn().mockResolvedValueOnce({ state: 'blocked' });
    await expect(
      verifiedRateSnapshot(configured, database(rpc), { allowRefresh: false }),
    ).rejects.toMatchObject({ code: 'RATES_UNVERIFIED' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('workflow read-only mode cannot exceed one external call or refresh stale proof', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi.fn().mockResolvedValue(null);
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    await expect(
      verifiedRateSnapshot(env(), database(rpc), { allowRefresh: false }),
    ).rejects.toMatchObject({ code: 'RATES_UNVERIFIED' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(outbound).not.toHaveBeenCalled();
  });
  it('concurrent refresh loser fails closed without a duplicate metadata request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ state: 'busy' });
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    await expect(verifiedRateSnapshot(env(), database(rpc))).rejects.toMatchObject({
      code: 'RATES_UNVERIFIED',
    });
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each([
    [
      'legacy wallet unavailable',
      () => Promise.resolve(new Response('{}', { status: 404 })),
      'METADATA_HTTP',
    ],
    ['null rates', () => Promise.resolve(new Response('{"rates":null}')), 'METADATA_PARSE'],
    ['oversized body', () => Promise.resolve(new Response(' '.repeat(65537))), 'METADATA_PARSE'],
    [
      'transport timeout',
      () => Promise.reject(new Error('connection interrupted')),
      'METADATA_HTTP',
    ],
  ])('fails closed and records failed proof for %s', async (_name, response, phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: 'claimed' })
      .mockResolvedValueOnce({ state: 'blocked' });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(response));
    await expect(verifiedRateSnapshot(env(), database(rpc))).rejects.toMatchObject({
      code: `RATES_UNVERIFIED_${phase}`,
    });
    expect(rpc).toHaveBeenLastCalledWith(
      'complete_provider_rate_refresh',
      expect.objectContaining({ p_valid: false }),
    );
  });
  it('fails closed when a valid response cannot be safely persisted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: 'claimed' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(wallet()))));
    await expect(verifiedRateSnapshot(env(), database(rpc))).rejects.toMatchObject({
      code: 'RATES_UNVERIFIED_ATTESTATION_STORE',
    });
  });
  it('rejects a cached proof for another API key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi.fn().mockResolvedValue(await proof({ keyFingerprint: 'f'.repeat(64) }));
    await expect(
      verifiedRateSnapshot(env(), database(rpc), { allowRefresh: false }),
    ).rejects.toMatchObject({ code: 'RATES_UNVERIFIED' });
  });
  it('canonicalizes skewed provider/database clocks without extending six-hour TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rpc = vi.fn().mockResolvedValue(
      await proof({
        providerAsOf: new Date(NOW + 45_000).toISOString(),
        verifiedAt: new Date(NOW + 20_000).toISOString(),
        expiresAt: new Date(NOW + 20_000 + SIX_HOURS).toISOString(),
      }),
    );
    const snapshot = await verifiedRateSnapshot(env(), database(rpc), { allowRefresh: false });
    expect(snapshot.TINYFISH_RATES_VERIFIED_AT).toBe(new Date(NOW).toISOString());
    expect(snapshot.TINYFISH_RATES_EXPIRES_AT).toBe(new Date(NOW + SIX_HOURS).toISOString());
    expect(providerReady({ ...env(), ...snapshot })).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('does not query storage or wallet while the provider is disabled', async () => {
    const rpc = vi.fn();
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    await expect(
      verifiedRateSnapshot({ ...env(), TINYFISH_ENABLED: 'false' }, database(rpc)),
    ).rejects.toMatchObject({ code: 'RATES_UNVERIFIED' });
    expect(rpc).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
});
