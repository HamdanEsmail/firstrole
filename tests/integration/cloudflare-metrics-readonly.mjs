// Read-only Cloudflare analytics. Uses the existing Wrangler authentication in
// memory; never prints/persists credentials, request headers, account IDs, or URLs.
// No Worker invocation, Workflow creation, TinyFish call, or configuration change.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execute = promisify(execFile);
const parseCliJson = (raw) => {
  for (let i = 0; i < raw.length; i++) {
    if (!['{', '['].includes(raw[i])) continue;
    try {
      return JSON.parse(raw.slice(i));
    } catch {
      /* Ignore CLI banner text. */
    }
  }
  throw new Error('unreadable authentication response');
};
let phase = 'configuration';
try {
  const config = await readFile('wrangler.jsonc', 'utf8');
  const account = config.match(/"account_id"\s*:\s*"([a-f0-9]{32})"/)?.[1];
  const script = config.match(/"name"\s*:\s*"([a-z0-9-]+)"/)?.[1];
  if (!account || script !== 'firstrole') throw new Error('unexpected project');
  phase = 'existing Wrangler authentication';
  const { stdout } = await execute(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'],
    {
      timeout: 30000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    },
  );
  const auth = parseCliJson(stdout);
  if (!['oauth', 'api_token'].includes(auth.type) || typeof auth.token !== 'string')
    throw new Error('unsupported authentication');
  async function query(queryText, variables = {}) {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query: queryText, variables }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('analytics access unavailable');
    }
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw new Error('analytics response too large');
    return JSON.parse(raw);
  }
  const end = new Date(process.env.FIRSTROLE_METRICS_END || Date.now());
  const start = new Date(
    process.env.FIRSTROLE_METRICS_START || end.getTime() - 24 * 60 * 60 * 1000,
  );
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    end - start > 7 * 86400000
  )
    throw new Error('invalid date range');
  phase = 'Workers GraphQL metrics';
  const response = await query(
    `query FirstRoleMetrics($accountTag: string, $start: string, $end: string, $script: string) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 100, filter: {scriptName: $script, datetime_geq: $start, datetime_leq: $end}) {
        dimensions { status }
        sum { requests errors subrequests }
        quantiles { __typename cpuTimeP50 cpuTimeP99 }
      }
    }}
  }`,
    { accountTag: account, start: start.toISOString(), end: end.toISOString(), script },
  );
  if (response.errors?.length) {
    const messages = response.errors.map((error) => String(error.message));
    const reason = messages.some((value) =>
      /permission|not authorized|denied|authentication|not allowed/i.test(value),
    )
      ? 'analytics permission unavailable'
      : 'analytics query unsupported';
    console.log(
      JSON.stringify({ status: 'UNVERIFIED', phase, reason, errorCount: messages.length }),
    );
    process.exitCode = 2;
  } else {
    const rows = response.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(rows)) throw new Error('missing metrics');
    const typeName = rows[0]?.quantiles?.__typename;
    let cpuDescription = null;
    if (typeof typeName === 'string' && /^[A-Za-z0-9_]+$/.test(typeName)) {
      const schema = await query(
        'query MetricUnits($name: String!) { __type(name:$name) { fields { name description } } }',
        { name: typeName },
      );
      cpuDescription =
        schema.data?.__type?.fields?.find((field) => field.name === 'cpuTimeP99')?.description ||
        null;
    }
    const workflowMetrics = [];
    for (const workflowName of ['firstrole-search', 'firstrole-agent', 'firstrole-details']) {
      const workflowResponse = await query(`query FirstRoleWorkflowCPU($accountTag: string, $filter: AccountWorkflowsAdaptiveGroupsFilter_InputObject!) {
        viewer { accounts(filter: {accountTag: $accountTag}) {
          workflowsAdaptiveGroups(limit: 200, filter: $filter) {
            count dimensions { workflowName eventType instanceId }
            sum { cpuTime retryCount stepCount allStepCount }
          }
        }}
      }`, { accountTag: account, filter: { workflowName, datetime_geq: start.toISOString(), datetime_leq: end.toISOString() } });
      const entries = workflowResponse.data?.viewer?.accounts?.[0]?.workflowsAdaptiveGroups;
      if (!Array.isArray(entries)) { workflowMetrics.push({ workflowName, status: 'UNVERIFIED' }); continue; }
      const instances = new Map();
      const eventTypes = new Set();
      let retries = 0;
      for (const entry of entries) {
        const id = entry.dimensions.instanceId;
        instances.set(id, (instances.get(id) || 0) + Number(entry.sum?.cpuTime || 0));
        retries += Number(entry.sum?.retryCount || 0);
        eventTypes.add(entry.dimensions.eventType);
      }
      const cpuTotals = [...instances.values()].filter((value) => value > 0);
      workflowMetrics.push({ workflowName, status: entries.length ? 'VERIFIED' : 'NO_DATA',
        instances: instances.size, recordedCpuUnit: 'milliseconds',
        smallestRecordedInstanceCpuMs: cpuTotals.length ? Math.min(...cpuTotals) : null,
        largestRecordedInstanceCpuMs: cpuTotals.length ? Math.max(...cpuTotals) : null,
        recordedRetries: retries, eventTypes: [...eventTypes],
        caveat: 'Adaptive records summed per instance; not a maximum per-step CPU measurement.' });
    }
    const report = {
      status: rows.length ? 'VERIFIED' : 'NO_DATA',
      script,
      window: { start: start.toISOString(), end: end.toISOString() },
      dataset: 'workersInvocationsAdaptive',
      cpuMetricDescription: cpuDescription,
      groups: rows.map((row) => ({
        status: row.dimensions?.status,
        requests: row.sum?.requests,
        errors: row.sum?.errors,
        subrequests: row.sum?.subrequests,
        cpuTimeP50: row.quantiles?.cpuTimeP50,
        cpuTimeP99: row.quantiles?.cpuTimeP99,
      })),
      workflowMetrics,
      limits:
        'Adaptive aggregate metrics; not a maximum per Workflow step or a concurrency stress test.',
    };
    await mkdir(resolve('artifacts/private'), { recursive: true });
    await writeFile(
      resolve('artifacts/private/cloudflare-metrics.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
} catch {
  console.log(
    JSON.stringify({
      status: 'UNVERIFIED',
      phase,
      reason: 'read-only analytics unavailable; credentials and raw errors suppressed',
    }),
  );
  process.exitCode = 2;
}
