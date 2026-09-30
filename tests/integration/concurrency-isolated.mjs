// Exact-function, multi-session PostgreSQL race test in the reviewed private QA schema.
// Default is a read-only readiness check. Pass --execute ONLY after setup SQL review.
// Never calls production admission/reservation/claim RPCs or any provider/Worker.
// Apply the paired cleanup SQL after this run, including if a check fails.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const RPC = 'qa_firstrole_concurrency_20260930';
const N = 16;
let settings;
let phase = 'configuration';
let checks = 0;
let baseline;
const check = (value) => {
  if (!value) throw new Error('assertion failed');
  checks++;
};
async function request(path, body) {
  const response = await fetch(`${settings.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      apikey: settings.key,
      authorization: `Bearer ${settings.key}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  if (raw.length > 512 * 1024) throw new Error('response too large');
  return { status: response.status, value: raw ? JSON.parse(raw) : null };
}
async function qa(action, args = {}) {
  const r = await request(`/rest/v1/rpc/${RPC}`, { p_action: action, p_args: args });
  check(r.status === 200);
  return r.value;
}
const guard =
  '/rest/v1/budget_guard?select=enabled,limit_usd,spent_usd,reserved_usd&singleton=eq.true';
let report;
try {
  const vars = Object.fromEntries(
    (await readFile('.dev.vars', 'utf8')).split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) return [];
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
      return [[m[1], v]];
    }),
  );
  const origin = new URL(vars.SUPABASE_URL);
  check(origin.origin === 'https://abhfpenjfdxvzbjodkqj.supabase.co');
  settings = { origin: origin.origin, key: vars.SUPABASE_SERVICE_ROLE_KEY };
  check(Boolean(settings.key));
  phase = 'isolated schema readiness';
  const ready = await request(`/rest/v1/rpc/${RPC}`, { p_action: 'stats', p_args: {} });
  if (ready.status === 404) {
    report = {
      status: 'SKIP',
      reason: 'Reviewed isolated setup SQL has not been applied; no changes made.',
    };
  } else {
    check(
      ready.status === 200 &&
        ready.value?.qaOnly === true &&
        ready.value.exactSourceCopies === true,
    );
    if (!process.argv.includes('--execute'))
      report = {
        status: 'READY',
        exactSourceCopies: true,
        concurrentRequests: N,
        mutations: 'Disposable QA schema only; production guard read-only.',
        providerCalls: 0,
      };
    else {
      baseline = await request(guard);
      check(
        baseline.status === 200 &&
          baseline.value?.length === 1 &&
          Number(baseline.value[0].limit_usd) === 10,
      );
      phase = 'fictional normal fixture';
      await qa('reset-normal');
      phase = 'concurrent request idempotency';
      const creates = await Promise.all(
        Array.from({ length: N }, () => qa('create', { id: randomUUID() })),
      );
      check(creates.every((r) => r.admitted === true));
      const ids = new Set(creates.map((r) => r.run.id));
      check(ids.size === 1 && creates.filter((r) => r.reused === false).length === 1);
      const runId = [...ids][0];
      phase = 'concurrent reservation idempotency';
      const reservations = await Promise.all(
        Array.from({ length: N }, () => qa('reserve', { runId, operationKey: 'same-operation' })),
      );
      check(reservations.every((r) => r.allowed === true));
      const operations = new Set(reservations.map((r) => r.operationId));
      check(operations.size === 1 && reservations.filter((r) => r.reused === false).length === 1);
      let stats = await qa('stats');
      check(
        stats.searches === 1 &&
          stats.operations === 1 &&
          stats.ledgerEntries === 1 &&
          Number(stats.guard.reserved) === 0.001 &&
          stats.totalSearchAdmissions === 1,
      );
      phase = 'concurrent dispatch claim';
      const claims = await Promise.all(
        Array.from({ length: N }, () =>
          qa('claim', { operationId: [...operations][0], claimToken: randomUUID() }),
        ),
      );
      check(claims.filter((r) => r.claimed === true).length === 1);
      stats = await qa('stats');
      check(
        Number(stats.guard.spent) === 0.001 &&
          Number(stats.guard.reserved) === 0 &&
          stats.ledgerEntries === 2,
      );
      phase = 'fictional ten-dollar boundary';
      await qa('reset-boundary');
      const boundaryRun = await qa('create', { id: randomUUID() });
      check(boundaryRun.admitted === true);
      const competing = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          qa('reserve', { runId: boundaryRun.run.id, operationKey: `distinct-${i}` }),
        ),
      );
      check(
        competing.filter((r) => r.allowed === true).length === 3 &&
          competing.filter((r) => r.reason === 'budget_exhausted').length === 13,
      );
      stats = await qa('stats');
      check(
        Number(stats.guard.spent) === 9.997 &&
          Number(stats.guard.reserved) === 0.003 &&
          Number(stats.guard.spent) + Number(stats.guard.reserved) === 10 &&
          stats.operations === 3,
      );
      phase = 'production guard unchanged';
      const after = await request(guard);
      check(after.status === 200 && JSON.stringify(after.value) === JSON.stringify(baseline.value));
      report = {
        status: 'PASS',
        independentRequestsPerRace: N,
        exactDeployedFunctionCopies: true,
        uniqueAdmission: 1,
        uniqueReservation: 1,
        successfulClaims: 1,
        fictionalBoundary: {
          limit: 10,
          openingSpent: 9.997,
          reserved: 0.003,
          allowed: 3,
          denied: 13,
        },
        productionBudgetUnchanged: true,
        providerCalls: 0,
        cleanupRequired:
          'Apply concurrency-isolated-cleanup.sql to remove only the reviewed QA objects.',
      };
    }
  }
} catch {
  report = {
    status: 'FAIL',
    phase,
    credentialsSuppressed: true,
    cleanupRequired: 'Apply concurrency-isolated-cleanup.sql if setup was applied.',
  };
  process.exitCode = 1;
}
if (baseline) {
  try {
    const after = await request(guard);
    report.productionBudgetUnchanged =
      JSON.stringify(after.value) === JSON.stringify(baseline.value);
  } catch {
    report.productionBudgetUnchanged = 'unverified';
  }
}
report.checks = checks;
if (process.argv.includes('--execute')) {
  await mkdir('artifacts/private', { recursive: true });
  await writeFile('artifacts/private/concurrency-isolated.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
