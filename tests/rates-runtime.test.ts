import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Resolve the exact runtime used by Wrangler, not a separately guessed browser mock.
const requireWrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, Response: RuntimeResponse } = requireWrangler(
  'miniflare',
) as typeof import('miniflare');

async function exerciseRuntime(redirect = false, kind: 'rates' | 'catalog' = 'rates') {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'ts',
      contents: `
        import { verifiedRateSnapshot } from './server/rates';
        import { providerReady } from './server/env';
        import { Database } from './server/db';
        console.warn = () => {};
        const env = { SUPABASE_URL:'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY:'synthetic-public',
          SUPABASE_SERVICE_ROLE_KEY:'synthetic-service', GUEST_COOKIE_SECRET:'synthetic-cookie',
          TINYFISH_API_KEY:'synthetic-provider', TINYFISH_ENABLED:'true' };
        export default {async fetch(request) {
          if(new URL(request.url).pathname === '/catalog') {
            try {
              const jobs = await new Database(env).latestVerifiedJobs(['a'.repeat(64)]);
              return Response.json({ok:jobs.length===1 && jobs[0].id==='a'.repeat(64)});
            } catch(error) { return Response.json({ok:false,code:error.code}); }
          }
          const db = {async rpc(name, args) {
            if(name==='get_provider_rate_attestation') return null;
            if(name==='claim_provider_rate_refresh') return {state:'claimed'};
            if(name==='complete_provider_rate_refresh' && args.p_valid) {
              const verified = Math.min(Date.parse(args.p_provider_as_of),Date.now());
              return {state:'verified',keyFingerprint:args.p_key_fingerprint,providerAsOf:args.p_provider_as_of,
                verifiedAt:new Date(verified).toISOString(),expiresAt:new Date(verified+21600000).toISOString(),
                agentRate:args.p_agent_rate,searchRate:args.p_search_rate,fetchRate:args.p_fetch_rate};
            }
            return {state:'blocked'};
          }};
          try { const snapshot=await verifiedRateSnapshot(env,db);return Response.json({ok:providerReady({...env,...snapshot})}); }
          catch(error) { return Response.json({ok:false,code:error.code}); }
        }};`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
  });
  const requests: { url: string; redirect: string }[] = [];
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'rate-preflight-test',
          compatibilityDate: '2026-09-29',
          manifest: {
            mainModule: 'index.js',
            modules: { 'index.js': { type: 'esm', contents: bundle.outputFiles[0].text } },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: (request) => {
              requests.push({ url: request.url, redirect: request.redirect });
              if (redirect)
                return new RuntimeResponse(null, {
                  status: 302,
                  headers: { location: 'https://untrusted.invalid/target' },
                });
              if (kind === 'catalog')
                return RuntimeResponse.json([
                  { job_id: 'a'.repeat(64), job: { id: 'a'.repeat(64) } },
                ]);
              return RuntimeResponse.json({
                rates: {
                  as_of: new Date().toISOString(),
                  meters: [
                    { label: 'TinyFish Agent', unit_amount: '0.016', currency: 'USD', per: 'step' },
                    {
                      label: 'TinyFish Search',
                      unit_amount: '0.005',
                      currency: 'USD',
                      per: 'query',
                    },
                    { label: 'TinyFish Fetch', unit_amount: '0.001', currency: 'USD', per: 'url' },
                  ],
                },
              });
            },
          },
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch(`http://local.test/${kind}`);
    return { result: (await response.json()) as { ok: boolean; code?: string }, requests };
  } finally {
    await runtime.dispose();
  }
}

describe('actual Cloudflare workerd rate preflight', () => {
  it('runs the actual rates module with supported manual redirect mode', async () => {
    const checked = await exerciseRuntime();
    expect(checked.result).toEqual({ ok: true });
    expect(checked.requests).toHaveLength(1);
    expect(checked.requests[0].url).toBe('https://agent.tinyfish.ai/v1/wallet');
  });
  it('rejects a redirect without sending credentials to a second destination', async () => {
    const checked = await exerciseRuntime(true);
    expect(checked.result).toEqual({ ok: false, code: 'RATES_UNVERIFIED_METADATA_HTTP' });
    expect(checked.requests).toHaveLength(1);
  });
});

describe('actual Cloudflare workerd catalog read', () => {
  it('loads the real database adapter without unsupported redirect options', async () => {
    const checked = await exerciseRuntime(false, 'catalog');
    expect(checked.result).toEqual({ ok: true });
    expect(checked.requests).toHaveLength(1);
    expect(new URL(checked.requests[0].url).pathname).toBe('/rest/v1/verified_jobs');
  });
  it('rejects a catalog redirect without forwarding the service credential', async () => {
    const checked = await exerciseRuntime(true, 'catalog');
    expect(checked.result).toEqual({ ok: false, code: 'STORAGE_UNAVAILABLE' });
    expect(checked.requests).toHaveLength(1);
  });
});
