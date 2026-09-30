import type { Database } from './db';
import type { Env } from './env';
import type { ExtractionConfig } from './extraction';
import type { FirecrawlConfig } from './firecrawl';
import { boundedJson, sha256 } from './http';

const MODEL = 'google/gemma-4-26b-a4b-it';
type Proof = Record<string, unknown> & { verifiedAt: string };
const disabledExtraction: ExtractionConfig = {
  enabled: false,
  providers: ['reka'],
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
  ratesVerifiedAt: '',
  keyFingerprint: '',
};

async function proof(
  db: Database,
  provider: string,
  key: string,
  obtain: () => Promise<Proof | null>,
  accepts: (proof: Proof) => boolean = () => true,
): Promise<(Proof & { keyFingerprint: string }) | null> {
  const keyFingerprint = await sha256(key);
  const cached = await db.rpc<Proof | null>('get_enrichment_provider_proof', {
    p_provider: provider,
    p_key_fingerprint: keyFingerprint,
  });
  if (cached && accepts(cached)) return { ...cached, keyFingerprint };
  const next = await obtain();
  if (!next) return null;
  const stored = await db.rpc<Proof | null>('put_enrichment_provider_proof', {
    p_provider: provider,
    p_key_fingerprint: keyFingerprint,
    p_proof: next,
  });
  return stored ? { ...stored, keyFingerprint } : null;
}

/** Verify the one allowed endpoint and enforce its price in every completion request. */
export async function extractionConfig(env: Env, db: Database): Promise<ExtractionConfig> {
  if (env.OPENROUTER_ENABLED !== 'true' || !env.OPENROUTER_API_KEY) return disabledExtraction;
  const provider = env.OPENROUTER_PROVIDER || 'reka';
  if (!['reka', 'nextbit/bf16', 'deepinfra/fp8'].includes(provider)) return disabledExtraction;
  try {
    const found = await proof(
      db,
      'openrouter',
      env.OPENROUTER_API_KEY,
      async () => {
        const response = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const data = await boundedJson<{ data?: { endpoints?: Array<Record<string, unknown>> } }>(
          response,
          192 * 1024,
        );
        const endpoint = data.data?.endpoints?.find(
          (item) => item.tag === provider && item.model_id === MODEL,
        );
        const parameters = endpoint?.supported_parameters;
        if (
          !endpoint ||
          !Array.isArray(parameters) ||
          !['response_format', 'structured_outputs', 'max_tokens'].every((item) =>
            parameters.includes(item),
          )
        )
          return null;
        const prices = endpoint.pricing as Record<string, unknown> | undefined;
        const inputPricePerMillion = Number((Number(prices?.prompt) * 1_000_000).toFixed(8));
        const outputPricePerMillion = Number((Number(prices?.completion) * 1_000_000).toFixed(8));
        if (
          !Number.isFinite(inputPricePerMillion) ||
          inputPricePerMillion < 0 ||
          inputPricePerMillion > 0.1 ||
          !Number.isFinite(outputPricePerMillion) ||
          outputPricePerMillion < 0 ||
          outputPricePerMillion > 0.4
        )
          return null;
        return {
          model: MODEL,
          providerSlug: provider,
          inputPricePerMillion,
          outputPricePerMillion,
          // This is also required on the routed request; unavailable ZDR fails rather than falling back.
          zeroDataRetention: true,
          verifiedAt: new Date().toISOString(),
        };
      },
      (cached) => cached.providerSlug === provider,
    );
    if (!found) return disabledExtraction;
    return {
      enabled: true,
      apiKey: env.OPENROUTER_API_KEY,
      providers: [provider],
      inputPricePerMillion: Number(found.inputPricePerMillion),
      outputPricePerMillion: Number(found.outputPricePerMillion),
      ratesVerifiedAt: found.verifiedAt,
      ratesExpiresAt: new Date(Date.parse(found.verifiedAt) + 6 * 60 * 60 * 1000).toISOString(),
      keyFingerprint: found.keyFingerprint,
    };
  } catch {
    return disabledExtraction;
  }
}

export async function firecrawlConfig(env: Env, db: Database): Promise<FirecrawlConfig> {
  const disabled: FirecrawlConfig = {
    enabled: false,
    freeOnly: false,
    freePlanVerifiedAt: '',
    keyFingerprint: '',
  };
  if (env.FIRECRAWL_ENABLED !== 'true' || !env.FIRECRAWL_API_KEY) return disabled;
  const attested = Date.parse(env.FIRECRAWL_FREE_PLAN_VERIFIED_AT || '');
  const age = Date.now() - attested;
  // The account screen supplies the free-plan attestation; the API cannot prove plan identity.
  // It expires after this pilot month, even if API balance reads continue to succeed.
  if (
    !Number.isFinite(attested) ||
    age < 0 ||
    age >= 30 * 86_400_000 ||
    (await sha256(env.FIRECRAWL_API_KEY)) !== env.FIRECRAWL_FREE_PLAN_KEY_SHA256
  )
    return disabled;
  try {
    const found = await proof(db, 'firecrawl', env.FIRECRAWL_API_KEY, async () => {
      const response = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
        headers: { authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const payload = await boundedJson<{
        success?: boolean;
        data?: { remainingCredits?: number; planCredits?: number };
      }>(response, 16 * 1024);
      const remaining = payload.data?.remainingCredits;
      // A larger paid allowance invalidates the attested free-only connection.
      if (
        payload.success !== true ||
        payload.data?.planCredits !== 1000 ||
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining) ||
        remaining < 1
      )
        return null;
      return { freeOnly: true, remainingCredits: remaining, verifiedAt: new Date().toISOString() };
    });
    return found
      ? {
          enabled: true,
          apiKey: env.FIRECRAWL_API_KEY,
          freeOnly: true,
          freePlanVerifiedAt: found.verifiedAt,
          keyFingerprint: found.keyFingerprint,
        }
      : disabled;
  } catch {
    return disabled;
  }
}

export const optionalReadersEnabled = (env: Env): boolean =>
  Boolean(
    env.ENRICHMENT_WORKFLOW &&
    ((env.OPENROUTER_ENABLED === 'true' && env.OPENROUTER_API_KEY) ||
      (env.FIRECRAWL_ENABLED === 'true' && env.FIRECRAWL_API_KEY)),
  );
