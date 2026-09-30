import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractionConfig, firecrawlConfig } from '../server/optional-rates';
import {
  enrichmentCandidate,
  observedDraft,
  selectEnrichmentCandidates,
  hasObservedIdentity,
} from '../server/enrichment-candidates';
import { sha256 } from '../server/http';
import { DEFAULT_PREFERENCES } from '../shared/types';
import type { Database } from '../server/db';
import type { Env } from '../server/env';

const key = 'test-only-key';
const env = {
  OPENROUTER_ENABLED: 'true',
  OPENROUTER_API_KEY: key,
  FIRECRAWL_ENABLED: 'true',
  FIRECRAWL_API_KEY: key,
} as Env;
const db = () =>
  ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
      name.startsWith('put_') ? args.p_proof : null,
    ),
  }) as unknown as Database;
const endpoint = (
  pricing = { prompt: '0.00000006', completion: '0.0000002' },
  parameters = ['response_format', 'structured_outputs', 'max_tokens'],
) =>
  new Response(
    JSON.stringify({
      data: {
        endpoints: [
          {
            tag: 'reka',
            model_id: 'google/gemma-4-26b-a4b-it',
            pricing,
            supported_parameters: parameters,
          },
        ],
      },
    }),
  );
afterEach(() => vi.unstubAllGlobals());

describe('optional reader rate verification', () => {
  it('checks exact endpoint capabilities and stores a key-bound proof without the key', async () => {
    const outbound = vi.fn(async () => endpoint());
    vi.stubGlobal('fetch', outbound);
    const store = db();
    const config = await extractionConfig(env, store);
    expect(config.enabled).toBe(true);
    expect(config.providers).toEqual(['reka']);
    expect(config.inputPricePerMillion).toBeCloseTo(0.06);
    expect(config.outputPricePerMillion).toBeCloseTo(0.2);
    expect(config.keyFingerprint).toBe(await sha256(key));
    expect(JSON.stringify(vi.mocked(store.rpc).mock.calls)).not.toContain(key);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledWith(
      expect.stringContaining('/endpoints'),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
  it.each([
    [
      { prompt: '0.00000011', completion: '0.0000002' },
      ['response_format', 'structured_outputs', 'max_tokens'],
    ],
    [
      { prompt: '0.00000006', completion: '0.00000041' },
      ['response_format', 'structured_outputs', 'max_tokens'],
    ],
    [{ prompt: '0.00000006', completion: '0.0000002' }, ['response_format', 'max_tokens']],
  ])('fails closed for a price increase or missing schema support', async (pricing, parameters) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        endpoint(pricing as { prompt: string; completion: string }, parameters as string[]),
      ),
    );
    expect((await extractionConfig(env, db())).enabled).toBe(false);
  });
  it('does not forward a key or follow a metadata redirect', async () => {
    const outbound = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://example.org' } }),
    );
    vi.stubGlobal('fetch', outbound);
    expect((await extractionConfig(env, db())).enabled).toBe(false);
    expect(JSON.stringify(outbound.mock.calls)).not.toContain(key);
  });
  it('requires a fresh, matching free-plan attestation and a free-sized active allowance', async () => {
    const configEnv = {
      ...env,
      FIRECRAWL_FREE_PLAN_VERIFIED_AT: new Date().toISOString(),
      FIRECRAWL_FREE_PLAN_KEY_SHA256: await sha256(key),
    };
    const outbound = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { planCredits: 1000, remainingCredits: 1025 } }),
        ),
    );
    vi.stubGlobal('fetch', outbound);
    expect((await firecrawlConfig(configEnv, db())).enabled).toBe(true);
    expect(
      (await firecrawlConfig({ ...configEnv, FIRECRAWL_FREE_PLAN_KEY_SHA256: 'wrong' }, db()))
        .enabled,
    ).toBe(false);
    expect(
      (
        await firecrawlConfig(
          {
            ...configEnv,
            FIRECRAWL_FREE_PLAN_VERIFIED_AT: new Date(Date.now() - 31 * 86_400_000).toISOString(),
          },
          db(),
        )
      ).enabled,
    ).toBe(false);
    expect(outbound).toHaveBeenCalledTimes(1);
  });
  it.each([0, 5000])('rejects an exhausted or upgraded allowance', async (amount) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { planCredits: amount || 1000, remainingCredits: amount },
            }),
          ),
      ),
    );
    expect(
      (
        await firecrawlConfig(
          {
            ...env,
            FIRECRAWL_FREE_PLAN_VERIFIED_AT: new Date().toISOString(),
            FIRECRAWL_FREE_PLAN_KEY_SHA256: await sha256(key),
          },
          db(),
        )
      ).enabled,
    ).toBe(false);
  });
});

describe('bounded observed detail candidates', () => {
  const url = 'https://careers.example.com/jobs/engineering-intern';
  it('never offers portals, blocked pages or closed listings to a fallback', () => {
    expect(enrichmentCandidate({ url: 'https://careers.example.com/', text: '' }, null)).toBeNull();
    expect(enrichmentCandidate({ url, text: 'Verify you are human' }, null)).toBeNull();
    expect(
      enrichmentCandidate({ url, text: 'This position is no longer available' }, null),
    ).toBeNull();
  });
  it('bounds text, links and workflow candidates without making network calls', () => {
    const candidate = enrichmentCandidate(
      { url, text: 'A'.repeat(50000), links: Array(80).fill('https://example.com/apply') },
      null,
    )!;
    expect(candidate.page.text).toHaveLength(12000);
    expect(candidate.page.links).toHaveLength(40);
    expect(
      selectEnrichmentCandidates([
        candidate,
        candidate,
        { ...candidate, sourceUrl: `${url}-2` },
        { ...candidate, sourceUrl: `${url}-3` },
      ]),
    ).toHaveLength(2);
    expect(
      new TextEncoder().encode(JSON.stringify(selectEnrichmentCandidates([candidate]))).byteLength,
    ).toBeLessThan(128 * 1024);
  });
  it('keeps incomplete source drafts private until both identity fields have evidence', async () => {
    const draft = await observedDraft(
      { url, title: 'Engineering Intern', text: 'A'.repeat(600) },
      DEFAULT_PREFERENCES,
    );
    expect(draft).not.toBeNull();
    expect(draft!.title).toBe('Job details');
    expect(hasObservedIdentity(draft!)).toBe(false);
  });
  it('bounds the complete UTF-8 workflow payload including large link collections', () => {
    const oversized = enrichmentCandidate({ url, text: '界'.repeat(12000), links: Array(40).fill(`https://example.com/${'a'.repeat(1900)}`) }, null)!;
    expect(selectEnrichmentCandidates([oversized])).toEqual([]);
  });
});
