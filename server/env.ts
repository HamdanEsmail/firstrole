export interface Env {
  ASSETS: Fetcher;
  SEARCH_WORKFLOW: Workflow<{ searchId: string }>;
  AGENT_WORKFLOW: Workflow<{ searchId: string; sourceUrl: string }>;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TINYFISH_API_KEY?: string;
  TINYFISH_ENABLED?: string;
  TINYFISH_RATES_VERIFIED_AT?: string;
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

export function providerReady(env: Env): boolean {
  const verified = Date.parse(env.TINYFISH_RATES_VERIFIED_AT ?? '');
  const age = Date.now() - verified;
  const rates = [
    Number(env.TINYFISH_AGENT_RATE),
    Number(env.TINYFISH_SEARCH_RATE),
    Number(env.TINYFISH_FETCH_RATE),
  ];
  return (
    databaseReady(env) &&
    env.TINYFISH_ENABLED === 'true' &&
    Boolean(env.TINYFISH_API_KEY) &&
    Number.isFinite(verified) &&
    age >= 0 &&
    age <= 24 * 60 * 60 * 1000 &&
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
