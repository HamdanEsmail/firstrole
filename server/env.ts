export interface Env {
  ASSETS: Fetcher;
  SEARCH_WORKFLOW: Workflow<{ searchId: string }>;
  AGENT_WORKFLOW: Workflow<import('./enrichment-candidates').AgentInput>;
  ENRICHMENT_WORKFLOW?: Workflow<import('./enrichment-candidates').EnrichmentInput>;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_ENABLED?: string;
  OPENROUTER_PROVIDER?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_ENABLED?: string;
  FIRECRAWL_FREE_PLAN_VERIFIED_AT?: string;
  FIRECRAWL_FREE_PLAN_KEY_SHA256?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TINYFISH_API_KEY?: string;
  TINYFISH_ENABLED?: string;
  TINYFISH_RATES_VERIFIED_AT?: string;
  /** Optional binding for an initial, manually verified rate proof. */
  TINYFISH_RATES_KEY_SHA256?: string;
  /** Runtime-only proof expiry, retained in safe Workflow rate snapshots. */
  TINYFISH_RATES_EXPIRES_AT?: string;
  TINYFISH_AGENT_RATE?: string;
  TINYFISH_SEARCH_RATE?: string;
  TINYFISH_FETCH_RATE?: string;
  GUEST_COOKIE_SECRET?: string;
  GOOGLE_AUTH_ENABLED?: string;
  APP_ORIGIN?: string;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function databaseReady(env: Env): boolean {
  return Boolean(
    env.SUPABASE_URL &&
    env.SUPABASE_PUBLISHABLE_KEY &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    env.GUEST_COOKIE_SECRET,
  );
}

export function providerConfigured(env: Env): boolean {
  return (
    databaseReady(env) && env.TINYFISH_ENABLED === 'true' && Boolean(env.TINYFISH_API_KEY?.trim())
  );
}

export function providerReady(env: Env): boolean {
  const verified = Date.parse(env.TINYFISH_RATES_VERIFIED_AT ?? '');
  const age = Date.now() - verified;
  const proofExpiry = env.TINYFISH_RATES_EXPIRES_AT
    ? Date.parse(env.TINYFISH_RATES_EXPIRES_AT)
    : null;
  const rates = [
    Number(env.TINYFISH_AGENT_RATE),
    Number(env.TINYFISH_SEARCH_RATE),
    Number(env.TINYFISH_FETCH_RATE),
  ];
  const rateValues = [env.TINYFISH_AGENT_RATE, env.TINYFISH_SEARCH_RATE, env.TINYFISH_FETCH_RATE];
  return (
    providerConfigured(env) &&
    Number.isFinite(verified) &&
    age >= 0 &&
    age <= 24 * 60 * 60 * 1000 &&
    rateValues.every(
      (rate) => typeof rate === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(rate),
    ) &&
    (proofExpiry === null ||
      (Number.isFinite(proofExpiry) &&
        proofExpiry > Date.now() &&
        proofExpiry - verified <= 6 * 60 * 60 * 1000)) &&
    rates.every(Number.isFinite) &&
    rates.every((rate) => rate >= 0) &&
    rates[0] <= 0.016 &&
    rates[1] <= 0.005 &&
    rates[2] <= 0.001
  );
}

export function requireProvider(env: Env): void {
  if (!providerReady(env))
    throw new AppError(
      'SEARCH_PAUSED',
      'Live searches are paused while the owner checks the pilot budget and service configuration. Your saved jobs are still available.',
      503,
    );
}
