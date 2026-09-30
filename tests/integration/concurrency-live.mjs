// Default: read-only readiness check. After review, pass --execute to create ONE
// disposable QA account and race sixteen cached admissions against real PostgreSQL.
// Never calls TinyFish or the Worker, creates Workflows, populates search_cache,
// reserves/claims provider operations, changes the budget, deletes ledger entries,
// or modifies anyone's saved jobs/notes. Requires an already-fresh real cache.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { resolve } from 'node:path';

const PROJECT = 'abhfpenjfdxvzbjodkqj';
const COUNT = 16;
const execute = process.argv.includes('--execute');
const batch = randomUUID();
let settings;
let created = null;
let phase = 'configuration';
let checks = 0;
let report = null;
let cleanupFailed = false;
const assert = (ok) => {
  if (!ok) throw new Error('assertion failed');
  checks++;
};
function readVars(raw) {
  return Object.fromEntries(
    raw.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) return [];
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      return [[match[1], value]];
    }),
  );
}
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${settings.origin}${path}`, {
    method,
    headers: {
      apikey: settings.secret,
      authorization: `Bearer ${settings.secret}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
  });
  const raw = await response.text();
  if (raw.length > 2 * 1024 * 1024) throw new Error('response too large');
  return { status: response.status, value: raw ? JSON.parse(raw) : null };
}
async function rpc(name, body) {
  const response = await request(`/rest/v1/rpc/${name}`, { method: 'POST', body });
  assert(response.status === 200);
  return response.value;
}
const guardPath =
  '/rest/v1/budget_guard?select=enabled,limit_usd,spent_usd,reserved_usd&singleton=eq.true';

try {
  const vars = readVars(await readFile(resolve('.dev.vars'), 'utf8'));
  const target = new URL(vars.SUPABASE_URL);
  assert(
    target.protocol === 'https:' &&
      target.hostname === `${PROJECT}.supabase.co` &&
      target.pathname === '/' &&
      !target.username &&
      !target.password,
  );
  settings = {
    origin: target.origin,
    secret: vars.SUPABASE_SERVICE_ROLE_KEY,
    hmacSecret: vars.GUEST_COOKIE_SECRET,
  };
  assert(Boolean(settings.secret && settings.hmacSecret));
  phase = 'fresh real cache precondition';
  const minimumExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const cache = await request(
    `/rest/v1/search_cache?select=fingerprint,expires_at&expires_at=gt.${encodeURIComponent(minimumExpiry)}&order=expires_at.desc&limit=1`,
  );
  assert(cache.status === 200 && Array.isArray(cache.value));
  const fresh = cache.value[0];
  if (!fresh) {
    report = {
      status: 'SKIP',
      reason:
        'No real cache with at least five minutes remaining; no QA account or other data created.',
    };
  } else if (!execute) {
    report = {
      status: 'READY',
      concurrentRequests: COUNT,
      freshRealCacheAvailable: true,
      mutationsIfExecuted:
        'One temporary QA Auth user and one owned cached search; automatic exact-ID cleanup.',
      providerCalls: 0,
      providerReservations: 0,
      publicCacheWrites: 0,
      coverage:
        'Concurrent deployed cached-admission idempotency and ownership, not a monetary-reservation race.',
    };
  } else {
    phase = 'guard baseline';
    const baseline = await request(guardPath);
    assert(
      baseline.status === 200 &&
        baseline.value?.length === 1 &&
        Number(baseline.value[0].limit_usd) === 10,
    );
    phase = 'create disposable QA ownership';
    const email = `firstrole-concurrency-${batch}@example.invalid`;
    const password = `Qa!${randomBytes(36).toString('base64url')}7a`;
    const response = await request('/auth/v1/admin/users', {
      method: 'POST',
      body: {
        email,
        password,
        email_confirm: true,
        app_metadata: { firstrole_qa_run: batch },
        user_metadata: { firstrole_qa: true },
      },
    });
    const user = response.value?.user ?? response.value;
    if (typeof user?.id === 'string' && /^[a-f\d-]{36}$/i.test(user.id))
      created = { id: user.id, email };
    assert([200, 201].includes(response.status) && created && user.email === email);
    const digest = (value) =>
      createHmac('sha256', settings.hmacSecret).update(value).digest('base64url');
    const actor = digest(`user:${created.id}`);
    const network = digest(`qa-network:${batch}`);
    const candidates = Array.from({ length: COUNT }, () => randomUUID());
    const idempotency = `qa-cache-${batch}`;
    phase = 'sixteen simultaneous deployed admissions';
    const started = Date.now();
    const results = await Promise.all(
      candidates.map(async (id) =>
        rpc('create_search_run', {
          p_run_id: id,
          p_actor_key: actor,
          p_owner_id: created.id,
          p_guest_id: null,
          p_network_key: network,
          p_fingerprint: fresh.fingerprint,
          p_assisted: false,
          p_idempotency_key: idempotency,
          p_payload: {
            id,
            cached: true,
            status: 'queued',
            stage: 'Private QA cache replay',
            preferences: {
              role: 'Private cache concurrency QA',
              location: 'Worldwide',
              jobTypes: ['internship', 'graduate', 'entry-level'],
              workplaces: [],
              keywords: '',
              sponsorshipRequired: false,
              postedWithinDays: null,
            },
            results: [],
            sources: [],
            errors: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      ),
    );
    const duration = Date.now() - started;
    assert(
      results.length === COUNT &&
        results.every((result) => result.admitted === true && result.run?.cached === true),
    );
    const ids = new Set(results.map((result) => result.run.id));
    assert(
      ids.size === 1 &&
        results.filter((result) => result.reused === false).length === 1 &&
        results.filter((result) => result.reused === true).length === COUNT - 1,
    );
    const [id] = ids;
    phase = 'one record and zero financial activity readback';
    const rows = await request(`/rest/v1/search_runs?owner_id=eq.${created.id}&select=id`);
    assert(rows.status === 200 && rows.value?.length === 1 && rows.value[0].id === id);
    const ops = await request(
      `/rest/v1/provider_operations?run_id=in.(${candidates.join(',')})&select=id`,
    );
    assert(ops.status === 200 && Array.isArray(ops.value) && ops.value.length === 0);
    const usage = await request(
      `/rest/v1/daily_usage?key_hash=in.(${encodeURIComponent(actor)},${encodeURIComponent(network)})&select=searches,assisted`,
    );
    assert(usage.status === 200 && Array.isArray(usage.value) && usage.value.length === 0);
    const own = await rpc('get_search_run', { p_run_id: id, p_actor_key: actor });
    const foreign = await rpc('get_search_run', {
      p_run_id: id,
      p_actor_key: digest(`foreign:${batch}`),
    });
    assert(own?.id === id && foreign === null);
    const after = await request(guardPath);
    assert(after.status === 200 && JSON.stringify(after.value) === JSON.stringify(baseline.value));
    report = {
      status: 'PASS',
      concurrentRequests: COUNT,
      uniqueOwnedRuns: ids.size,
      reusedResponses: COUNT - 1,
      elapsedMilliseconds: duration,
      providerOperations: 0,
      quotaRowsCreated: 0,
      budgetUnchanged: true,
      coverage:
        'Independent deployed RPC transactions racing one cached idempotency key; no monetary-reservation race was performed.',
    };
  }
} catch {
  report = {
    status: 'FAIL',
    phase,
    reason: 'Validation did not complete; credentials and raw responses suppressed.',
  };
  process.exitCode = 1;
} finally {
  if (created && settings) {
    try {
      const readback = await request(`/auth/v1/admin/users/${created.id}`);
      const user = readback.value?.user ?? readback.value;
      assert(
        readback.status === 200 &&
          user?.id === created.id &&
          user?.email === created.email &&
          user?.app_metadata?.firstrole_qa_run === batch,
      );
      const deletion = await request(`/auth/v1/admin/users/${created.id}`, { method: 'DELETE' });
      assert([200, 204].includes(deletion.status));
      const absent = await request(`/auth/v1/admin/users/${created.id}`);
      assert(absent.status === 404);
      const history = await request(`/rest/v1/search_runs?owner_id=eq.${created.id}&select=id`);
      assert(history.status === 200 && history.value?.length === 0);
      report.cleanup = 'QA user and owned search removed; cascade verified';
    } catch {
      cleanupFailed = true;
      process.exitCode = 1;
      report.status = 'FAIL';
      report.cleanup = 'Exact-ID cleanup needs attention';
      await mkdir(resolve('artifacts/private'), { recursive: true });
      await writeFile(
        resolve(`artifacts/private/concurrency-cleanup-${batch}.json`),
        JSON.stringify({ project: PROJECT, run: batch, userId: created.id }),
      );
    }
  }
}
report.checks = checks;
if (execute && !cleanupFailed) {
  await mkdir(resolve('artifacts/private'), { recursive: true });
  await writeFile(
    resolve('artifacts/private/concurrency-live.json'),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report));
