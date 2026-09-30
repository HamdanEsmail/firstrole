import type { EnrichmentMeter, EnrichmentTicket } from './enrichment-budget';
import { postingBlocked } from './extraction';
import { boundedJson, safePublicUrl, sha256 } from './http';
import { isJobDetail, listingClosed } from './quality';
import type { FetchedPage } from './tinyfish';

export interface FirecrawlConfig {
  enabled: boolean;
  apiKey?: string;
  keyFingerprint: string;
  /** Owner has checked that this connection uses the free plan without automatic purchases. */
  freeOnly: boolean;
  freePlanVerifiedAt: string;
}
export interface FirecrawlResult {
  page: FetchedPage | null;
  status: 'read' | 'disabled' | 'skipped' | 'limited' | 'failed';
}

/** One ordinary scrape after an empty/JS-shell TinyFish read; never a blocked-site workaround. */
export async function readPublicPosting(
  input: {
    sourceUrl: string;
    previousText: string;
    reason: 'empty' | 'shell';
    operationKey: string;
  },
  config: FirecrawlConfig,
  meter: EnrichmentMeter,
): Promise<FirecrawlResult> {
  const verified = Date.parse(config.freePlanVerifiedAt);
  const age = Date.now() - verified;
  if (
    !config.enabled ||
    !config.apiKey?.trim() ||
    !config.freeOnly ||
    !/^[a-f\d]{64}$/.test(config.keyFingerprint) ||
    (await sha256(config.apiKey)) !== config.keyFingerprint ||
    !Number.isFinite(verified) ||
    age < 0 ||
    age >= 86_400_000
  )
    return { page: null, status: 'disabled' };
  const url = safePublicUrl(input.sourceUrl);
  if (
    !url ||
    !isJobDetail(url) ||
    !['empty', 'shell'].includes(input.reason) ||
    input.previousText.trim().length >= 600 ||
    postingBlocked(input.previousText) ||
    listingClosed(input.previousText)
  )
    return { page: null, status: 'skipped' };
  let ticket: EnrichmentTicket | null = null;
  let settlementAttempted = false;
  try {
    ticket = await meter.admit({
      provider: 'firecrawl',
      operationKey: input.operationKey,
      keyFingerprint: config.keyFingerprint,
      units: 1,
      maxCostUsd: 0,
    });
    if (!ticket) return { page: null, status: 'limited' };
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
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
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Reader unavailable');
    }
    const payload = await boundedJson<{
      success?: boolean;
      data?: {
        markdown?: unknown;
        links?: unknown;
        metadata?: {
          title?: unknown;
          sourceURL?: unknown;
          url?: unknown;
          statusCode?: unknown;
          error?: unknown;
        };
      };
    }>(response, 192 * 1024);
    settlementAttempted = true;
    // The documented scrape response has no authoritative credit cost. Retain its one-credit reservation.
    await meter.settle(ticket, {
      outcome: payload.success === true ? 'completed' : 'unknown',
      authoritative: false,
    });
    const data = payload.data;
    if (payload.success !== true || !data || typeof data.markdown !== 'string')
      return { page: null, status: 'failed' };
    const text = data.markdown.slice(0, 60_000);
    const metadata = data.metadata;
    const final = safePublicUrl(metadata?.url || metadata?.sourceURL || url);
    // Keep the server-established posting identity; do not attach another page's facts after a redirect.
    if (
      final !== url ||
      (typeof metadata?.statusCode === 'number' && metadata.statusCode >= 400) ||
      metadata?.error ||
      postingBlocked(text) ||
      listingClosed(text) ||
      text.trim().length < 100
    )
      return { page: null, status: 'failed' };
    const links = Array.isArray(data.links)
      ? [
          ...new Set(
            data.links.flatMap((link) => {
              const safe = safePublicUrl(link);
              return safe ? [safe] : [];
            }),
          ),
        ].slice(0, 100)
      : [];
    return {
      page: {
        url,
        final_url: final,
        text,
        links,
        title: typeof metadata?.title === 'string' ? metadata.title.slice(0, 250) : null,
      },
      status: 'read',
    };
  } catch {
    if (ticket && !settlementAttempted)
      await meter.settle(ticket, { outcome: 'unknown', authoritative: false }).catch(() => {});
    return { page: null, status: 'failed' };
  }
}
