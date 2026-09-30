import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPublicPosting, type FirecrawlConfig } from '../server/firecrawl';
import { sha256 } from '../server/http';

const url = 'https://careers.example.com/jobs/software-intern';
const text =
  '# Software Engineering Intern\nLocation: Dubai\n## Job Description\nYou will build useful software and test applications with our engineering team.\nApply now';
async function config(changes: Partial<FirecrawlConfig> = {}): Promise<FirecrawlConfig> {
  return {
    enabled: true,
    apiKey: 'test-only-firecrawl-key',
    keyFingerprint: await sha256('test-only-firecrawl-key'),
    freeOnly: true,
    freePlanVerifiedAt: new Date().toISOString(),
    ...changes,
  };
}
function meter() {
  return {
    admit: vi
      .fn()
      .mockResolvedValue({
        operationId: 'op',
        claimToken: 'claim',
        provider: 'firecrawl' as const,
      }),
    settle: vi.fn().mockResolvedValue(undefined),
  };
}
const input = {
  sourceUrl: url,
  previousText: 'Loading careers portal',
  reason: 'shell' as const,
  operationKey: 'fallback-1',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('free-plan bounded Firecrawl reader', () => {
  it('reads one known public detail page without paid extras or proxy escalation', async () => {
    const outbound = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: text,
              metadata: { sourceURL: url, title: 'Software Engineering Intern', statusCode: 200 },
              links: [url, 'http://insecure.example', 'https://localhost/test'],
            },
          }),
        ),
      );
    vi.stubGlobal('fetch', outbound);
    const budget = meter();
    const result = await readPublicPosting(input, await config(), budget);
    expect(result.status).toBe('read');
    expect(result.page).toMatchObject({ url, final_url: url, text, links: [url] });
    expect(outbound).toHaveBeenCalledOnce();
    const [endpoint, request] = outbound.mock.calls[0];
    expect(endpoint).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(request.redirect).toBe('manual');
    expect(JSON.parse(request.body)).toEqual({
      url,
      formats: ['markdown', 'links'],
      onlyMainContent: true,
      maxAge: 0,
      timeout: 25_000,
      proxy: 'basic',
      parsers: [],
      storeInCache: false,
      removeBase64Images: true,
      blockAds: true,
    });
    expect(budget.admit.mock.invocationCallOrder[0]).toBeLessThan(
      outbound.mock.invocationCallOrder[0],
    );
    expect(budget.admit.mock.calls[0][0]).toMatchObject({
      provider: 'firecrawl',
      units: 1,
      maxCostUsd: 0,
    });
    expect(budget.settle).toHaveBeenCalledWith(expect.anything(), {
      outcome: 'completed',
      authoritative: false,
    });
  });
  it.each([
    'Access denied',
    'Please verify you are human',
    'CAPTCHA challenge',
    "The page you are looking for doesn't exist.",
    'a'.repeat(600),
  ])(
    'does not spend a fallback read on a blocked, removed or already readable page',
    async (previousText) => {
      const outbound = vi.fn();
      vi.stubGlobal('fetch', outbound);
      const budget = meter();
      expect(
        (await readPublicPosting({ ...input, previousText }, await config(), budget)).status,
      ).toBe('skipped');
      expect(outbound).not.toHaveBeenCalled();
      expect(budget.admit).not.toHaveBeenCalled();
    },
  );
  it.each([
    { enabled: false },
    { freeOnly: false },
    { freePlanVerifiedAt: '2020-01-01T00:00:00Z' },
    { keyFingerprint: 'b'.repeat(64) },
  ])('requires a current key-bound free-only attestation: %j', async (change) => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const budget = meter();
    expect((await readPublicPosting(input, await config(change), budget)).status).toBe('disabled');
    expect(outbound).not.toHaveBeenCalled();
  });
  it('rejects a non-detail URL or a denied operation without a provider call', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const budget = meter();
    expect(
      (
        await readPublicPosting(
          { ...input, sourceUrl: 'https://localhost/jobs/1' },
          await config(),
          budget,
        )
      ).status,
    ).toBe('skipped');
    budget.admit.mockResolvedValue(null);
    expect((await readPublicPosting(input, await config(), budget)).status).toBe('limited');
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each(['network', 'redirect', 'different-posting', 'denied-page'])(
    'returns null without retry for %s',
    async (failure) => {
      const outbound = vi.fn();
      if (failure === 'network') outbound.mockRejectedValue(new Error('lost connection'));
      if (failure === 'redirect')
        outbound.mockResolvedValue(
          new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
        );
      if (failure === 'different-posting')
        outbound.mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: text,
                metadata: { url: 'https://careers.example.com/jobs/other', statusCode: 200 },
              },
            }),
          ),
        );
      if (failure === 'denied-page')
        outbound.mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: 'Verify you are human. CAPTCHA.',
                metadata: { sourceURL: url, statusCode: 200 },
              },
            }),
          ),
        );
      vi.stubGlobal('fetch', outbound);
      const budget = meter();
      const result = await readPublicPosting(input, await config(), budget);
      expect(result).toEqual({ page: null, status: 'failed' });
      expect(outbound).toHaveBeenCalledOnce();
      expect(budget.settle).toHaveBeenCalledOnce();
      expect(budget.settle.mock.calls[0][1].authoritative).toBe(false);
    },
  );
});
