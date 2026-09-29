import { AppError, providerConfigured, providerReady, type Env } from './env';
import type { Database } from './db';
import { boundedJson, sha256 } from './http';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW = 60_000;
const WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';
const METERS = [
  { label: 'TinyFish Agent', per: 'step', cap: 0.016, field: 'agentRate' },
  { label: 'TinyFish Search', per: 'query', cap: 0.005, field: 'searchRate' },
  { label: 'TinyFish Fetch', per: 'url', cap: 0.001, field: 'fetchRate' },
] as const;

export interface VerifiedRates {
  providerAsOf: string;
  agentRate: string;
  searchRate: string;
  fetchRate: string;
}

/** Safe to persist in a Workflow step; contains no keys, identities or bindings. */
export interface RateSnapshot {
  TINYFISH_RATES_VERIFIED_AT: string;
  TINYFISH_AGENT_RATE: string;
  TINYFISH_SEARCH_RATE: string;
  TINYFISH_FETCH_RATE: string;
  TINYFISH_RATES_EXPIRES_AT?: string;
}

interface Attestation extends VerifiedRates {
  state: 'verified' | 'expired' | 'blocked' | 'refreshing';
  keyFingerprint: string;
  verifiedAt: string;
  expiresAt: string | null;
}

interface RefreshClaim {
  state: 'claimed' | 'ready' | 'busy';
  proof?: Attestation;
}

function unavailable(phase?: string): AppError {
  return new AppError(
    phase ? `RATES_UNVERIFIED_${phase.toUpperCase()}` : 'RATES_UNVERIFIED',
    'Live search is temporarily paused because current provider rates could not be verified. Saved and recent results remain available. Please try again shortly.',
    503,
  );
}

function decimal(value: unknown, cap: number): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= cap ? value : null;
}

function timestamp(value: unknown, now: number, futureAllowance = 0): string | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant <= now + futureAllowance && now - instant < SIX_HOURS
    ? value
    : null;
}

/** SDK 0.7.0 wallet contract; exact product labels/units also verified via its GET endpoint. */
export function parseWalletRates(value: unknown, now = Date.now()): VerifiedRates {
  if (!value || typeof value !== 'object') throw unavailable();
  const rates = (value as Record<string, unknown>).rates;
  if (!rates || typeof rates !== 'object') throw unavailable();
  const source = rates as Record<string, unknown>;
  const providerAsOf = timestamp(source.as_of, now, MAX_CLOCK_SKEW);
  if (!providerAsOf || !Array.isArray(source.meters) || source.meters.length > 100)
    throw unavailable();
  const result = { providerAsOf } as VerifiedRates;
  for (const expected of METERS) {
    const matches = source.meters.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && item.label === expected.label),
    );
    if (matches.length !== 1) throw unavailable();
    const meter = matches[0];
    const amount = decimal(meter.unit_amount, expected.cap);
    if (!amount || meter.currency !== 'USD' || meter.per !== expected.per) throw unavailable();
    result[expected.field] = amount;
  }
  return result;
}

function proofSnapshot(value: unknown, fingerprint: string): RateSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const proof = value as Attestation;
  const now = Date.now();
  const providerTime = timestamp(proof.providerAsOf, now, MAX_CLOCK_SKEW);
  const serverTime = timestamp(proof.verifiedAt, now, MAX_CLOCK_SKEW);
  const expiry = typeof proof.expiresAt === 'string' ? Date.parse(proof.expiresAt) : NaN;
  if (
    proof.state !== 'verified' ||
    proof.keyFingerprint !== fingerprint ||
    !providerTime ||
    !serverTime ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > Math.min(Date.parse(providerTime), Date.parse(serverTime)) + SIX_HOURS
  )
    return null;
  if (
    !decimal(proof.agentRate, 0.016) ||
    !decimal(proof.searchRate, 0.005) ||
    !decimal(proof.fetchRate, 0.001)
  )
    return null;
  // Independent provider/database/Worker clocks may differ slightly. Keep the
  // runtime proof nonfuture and never extend its TTL beyond either server clock.
  const canonicalTime = Math.min(Date.parse(providerTime), Date.parse(serverTime), now);
  return {
    TINYFISH_RATES_VERIFIED_AT: new Date(canonicalTime).toISOString(),
    TINYFISH_RATES_EXPIRES_AT: new Date(Math.min(expiry, canonicalTime + SIX_HOURS)).toISOString(),
    TINYFISH_AGENT_RATE: proof.agentRate,
    TINYFISH_SEARCH_RATE: proof.searchRate,
    TINYFISH_FETCH_RATE: proof.fetchRate,
  };
}

function manualSnapshot(env: Env): RateSnapshot {
  return {
    TINYFISH_RATES_VERIFIED_AT: env.TINYFISH_RATES_VERIFIED_AT!,
    TINYFISH_AGENT_RATE: env.TINYFISH_AGENT_RATE!,
    TINYFISH_SEARCH_RATE: env.TINYFISH_SEARCH_RATE!,
    TINYFISH_FETCH_RATE: env.TINYFISH_FETCH_RATE!,
    ...(env.TINYFISH_RATES_EXPIRES_AT
      ? { TINYFISH_RATES_EXPIRES_AT: env.TINYFISH_RATES_EXPIRES_AT }
      : {}),
  };
}

export async function verifiedRateSnapshot(
  env: Env,
  db: Pick<Database, 'rpc'>,
  { allowRefresh = true }: { allowRefresh?: boolean } = {},
): Promise<RateSnapshot> {
  if (!providerConfigured(env)) throw unavailable();
  const fingerprint = await sha256(env.TINYFISH_API_KEY!);
  const existing = await db.rpc<Attestation | null>('get_provider_rate_attestation', {
    p_key_fingerprint: fingerprint,
  });
  const current = proofSnapshot(existing, fingerprint);
  if (current) return current;
  // Initial owner proof is a bounded fallback only when there is no stored state.
  // A failed/expired/refreshing observation never falls back to older manual rates.
  if (existing === null && env.TINYFISH_RATES_KEY_SHA256 === fingerprint && providerReady(env))
    return manualSnapshot(env);
  // Workflow callers use one DB read and cannot issue extra wallet requests.
  if (!allowRefresh) throw unavailable();

  const token = crypto.randomUUID();
  const claim = await db.rpc<RefreshClaim>('claim_provider_rate_refresh', {
    p_key_fingerprint: fingerprint,
    p_refresh_token: token,
  });
  if (claim.state === 'ready') {
    const ready = proofSnapshot(claim.proof, fingerprint);
    if (ready) return ready;
    throw unavailable();
  }
  if (claim.state !== 'claimed') throw unavailable();

  let phase = 'metadata_http';
  let httpStatus: number | undefined;
  let providerClockAheadMs: number | undefined;
  let storedState: string | undefined;
  try {
    const response = await fetch(WALLET_URL, {
      method: 'GET',
      headers: { 'X-API-Key': env.TINYFISH_API_KEY!, Accept: 'application/json' },
      // workerd supports only follow/manual. Manual plus !ok below rejects 3xx
      // without forwarding the API key to a redirected destination.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    phase = 'metadata_parse';
    const raw = await boundedJson<{ rates?: { as_of?: unknown } }>(response, 64 * 1024);
    const observedTime = typeof raw?.rates?.as_of === 'string' ? Date.parse(raw.rates.as_of) : NaN;
    if (Number.isFinite(observedTime)) providerClockAheadMs = Math.round(observedTime - Date.now());
    const rates = parseWalletRates(raw);
    phase = 'attestation_store';
    const saved = await db.rpc<Attestation | null>('complete_provider_rate_refresh', {
      p_key_fingerprint: fingerprint,
      p_refresh_token: token,
      p_valid: true,
      p_provider_as_of: rates.providerAsOf,
      p_agent_rate: rates.agentRate,
      p_search_rate: rates.searchRate,
      p_fetch_rate: rates.fetchRate,
    });
    storedState = saved?.state;
    const snapshot = proofSnapshot(saved, fingerprint);
    if (!snapshot) throw unavailable();
    return snapshot;
  } catch {
    // Never log keys, key fingerprints, wallet balances, raw bodies, or provider errors.
    console.warn('firstrole_rate_verification', {
      phase,
      httpStatus,
      providerClockAheadMs,
      storedState,
    });
    // A stale request cannot invalidate another request's newer successful proof:
    // completion is fenced by this exact short-lived refresh token in SQL.
    await db
      .rpc('complete_provider_rate_refresh', {
        p_key_fingerprint: fingerprint,
        p_refresh_token: token,
        p_valid: false,
      })
      .catch(() => {});
    throw unavailable(phase);
  }
}

export async function verifiedProviderEnv(env: Env, db: Pick<Database, 'rpc'>): Promise<Env> {
  return { ...env, ...(await verifiedRateSnapshot(env, db)) };
}
