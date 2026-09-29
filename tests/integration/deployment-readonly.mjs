// Read-only deployed smoke checks. Never starts a Workflow or calls TinyFish.
// Required: FIRSTROLE_BASE_URL. Optional: SUPABASE_SERVICE_ROLE_KEY for private read checks.
// Optional expected flags: FIRSTROLE_EXPECT_SEARCH_ENABLED, FIRSTROLE_EXPECT_GOOGLE_ENABLED,
// FIRSTROLE_EXPECT_BUDGET_ENABLED (defaults to false for a safe initial deployment).
// Only status summaries and budget numbers are printed; never keys, tokens, cookies or response bodies.
import { randomUUID } from 'node:crypto';

const base = process.env.FIRSTROLE_BASE_URL;
if (!base) throw new Error('Set FIRSTROLE_BASE_URL to the deployed app origin.');
const parsed = new URL(base);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/') {
  throw new Error('FIRSTROLE_BASE_URL must be an HTTPS origin without credentials or a path.');
}
const origin = parsed.origin;
let failed = 0;
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failed++;
}
function flag(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
  return value === 'true';
}
async function read(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    const raw = await response.text();
    if (raw.length > 1_000_000) throw new Error('Response exceeded smoke-check size limit.');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* An HTML asset is expected for the root page. */ }
    return { status: response.status, headers: response.headers, body, text: raw };
  } catch {
    return { status: 0, headers: new Headers(), body: null, text: '' };
  }
}

const [root, health, configResponse] = await Promise.all([
  read(`${origin}/`), read(`${origin}/api/health`), read(`${origin}/api/config`),
]);
check('SPA assets served at the root', root.status === 200 && root.headers.get('content-type')?.includes('text/html') && root.text.includes('FirstRole'));
check('API routing reaches the Worker instead of SPA HTML', health.status === 200 && health.body?.ok === true && health.headers.get('content-type')?.includes('application/json'));
check('API responses are not cached', health.headers.get('cache-control') === 'no-store');
const config = configResponse.body;
const allowedConfigKeys = new Set(['supabaseUrl', 'supabasePublishableKey', 'searchEnabled', 'googleEnabled', 'setupMessage']);
check('Public config contains only the documented safe fields', configResponse.status === 200 && config && Object.keys(config).every(key => allowedConfigKeys.has(key)) && typeof config.searchEnabled === 'boolean' && typeof config.googleEnabled === 'boolean');
for (const [key, environment] of [['searchEnabled', 'FIRSTROLE_EXPECT_SEARCH_ENABLED'], ['googleEnabled', 'FIRSTROLE_EXPECT_GOOGLE_ENABLED']]) {
  const expected = flag(environment);
  if (expected !== undefined) check(`${key} matches the deployment stage`, config?.[key] === expected);
}

const missingSearch = await read(`${origin}/api/searches/${randomUUID()}`);
check('Owned-search read reaches Supabase and rejects an absent search', missingSearch.status === 404 && missingSearch.body?.error?.code === 'NOT_FOUND');
const cookie = missingSearch.headers.get('set-cookie') || '';
check('Guest cookie is HttpOnly, Secure and SameSite=Lax', /HttpOnly/i.test(cookie) && /(?:^|;)\s*Secure(?:;|$)/i.test(cookie) && /SameSite=Lax/i.test(cookie));

if (typeof config?.supabaseUrl === 'string' && typeof config?.supabasePublishableKey === 'string' && config.supabaseUrl && config.supabasePublishableKey) {
  const dbOrigin = new URL(config.supabaseUrl);
  if (dbOrigin.protocol !== 'https:' || dbOrigin.username || dbOrigin.password || !dbOrigin.hostname.endsWith('.supabase.co')) throw new Error('Unexpected database origin in public config.');
  const dbUrl = dbOrigin.origin;
  const publicHeaders = { apikey: config.supabasePublishableKey, 'content-type': 'application/json' };
  const [privateTable, privateRpc] = await Promise.all([
    read(`${dbUrl}/rest/v1/budget_guard?select=singleton&limit=1`, { headers: publicHeaders }),
    read(`${dbUrl}/rest/v1/rpc/get_search_cache`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ p_fingerprint: `smoke-readonly-${randomUUID()}` }) }),
  ]);
  check('Publishable credentials cannot read the budget table', [401, 403].includes(privateTable.status));
  check('Publishable credentials cannot invoke private cache RPC', [401, 403].includes(privateRpc.status));

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (secret) {
    const serviceHeaders = { apikey: secret, authorization: `Bearer ${secret}` };
    const guard = await read(`${dbUrl}/rest/v1/budget_guard?select=enabled,limit_usd,spent_usd,reserved_usd&singleton=eq.true`, { headers: serviceHeaders });
    const row = Array.isArray(guard.body) ? guard.body[0] : null;
    check('Service role can read the single pilot guard', guard.status === 200 && Array.isArray(guard.body) && guard.body.length === 1);
    check('Pilot envelope is exactly $10 and accounted usage stays within it', row && Number(row.limit_usd) === 10 && Number(row.spent_usd) >= 0 && Number(row.reserved_usd) >= 0 && Number(row.spent_usd) + Number(row.reserved_usd) <= 10);
    check('Database spending switch matches the deployment stage', row?.enabled === (flag('FIRSTROLE_EXPECT_BUDGET_ENABLED') ?? false));
    if (row) console.log(`Budget: limit=$${Number(row.limit_usd).toFixed(3)}, spent=$${Number(row.spent_usd).toFixed(3)}, reserved=$${Number(row.reserved_usd).toFixed(3)}, enabled=${row.enabled === true}`);
  } else console.log('SKIP private guard read: service-role environment value was not supplied.');
} else check('Supabase public configuration is present', false);

console.log(`Read-only deployment smoke complete: ${failed} failed checks. No provider runs or database mutations were requested.`);
process.exitCode = failed ? 1 : 0;
