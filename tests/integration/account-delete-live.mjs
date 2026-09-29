// Explicitly authorized deployed account-deletion check. Creates exactly one
// disposable confirmed QA user, writes only that user's two private fixture
// rows, and deletes that exact user through the deployed Worker. No emails,
// job searches, provider calls, or ledger mutations are made by this script.
// Run from the repository root: node tests/integration/account-delete-live.mjs
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const expectedProject = 'abhfpenjfdxvzbjodkqj';
const workerOrigin = 'https://firstrole.hamdanesmail12-7a9.workers.dev';
const runId = randomUUID();
const qaEmail = `firstrole-delete-qa-${runId}@example.invalid`;
const qaPassword = `Qa!${randomBytes(40).toString('base64url')}7a`;
let settings;
let createdUserId = null;
let phase = 'read configuration';
let failedPhase = null;
let cleanupFailed = false;
let completed = false;

function assert(condition) {
  if (!condition) throw new Error('verification failed');
}

function parseVars(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

async function send(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  const raw = await response.text();
  assert(raw.length <= 512 * 1024);
  const countHeader = response.headers.get('x-total-count');
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) : null,
    total: countHeader !== null && /^\d+$/.test(countHeader) ? Number(countHeader) : null,
  };
}

function request(path, { method = 'GET', admin = false, token, body } = {}) {
  const headers = { apikey: admin ? settings.secret : settings.publicKey };
  if (admin) headers.authorization = `Bearer ${settings.secret}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  return send(`${settings.origin}${path}`, { method, headers, body });
}

const userPath = (id) => `/auth/v1/admin/users/${encodeURIComponent(id)}`;
const rowPath = (table, id) => `/rest/v1/${table}?user_id=eq.${encodeURIComponent(id)}&select=user_id`;
const guardPath = '/rest/v1/budget_guard?singleton=eq.true&select=enabled,limit_usd,spent_usd,reserved_usd';

async function countUsers() {
  // Count comes from the official Admin API pagination header. The unrelated
  // user response is not inspected, logged, or persisted.
  const response = await request('/auth/v1/admin/users?page=1&per_page=1', { admin: true });
  assert(response.status === 200 && Number.isInteger(response.total) && response.total >= 0);
  return response.total;
}

async function assertOwnRowsAbsent() {
  for (const table of ['profiles', 'saved_jobs']) {
    const rows = await request(rowPath(table, createdUserId), { admin: true });
    assert(rows.status === 200 && Array.isArray(rows.body) && rows.body.length === 0);
  }
}

try {
  const vars = parseVars(await readFile(resolve('.dev.vars'), 'utf8'));
  const supabaseUrl = new URL(vars.SUPABASE_URL);
  assert(supabaseUrl.protocol === 'https:' && supabaseUrl.hostname === `${expectedProject}.supabase.co` && supabaseUrl.pathname === '/' && !supabaseUrl.username && !supabaseUrl.password);
  settings = { origin: supabaseUrl.origin, secret: vars.SUPABASE_SERVICE_ROLE_KEY, publicKey: vars.SUPABASE_PUBLISHABLE_KEY };
  assert(Boolean(settings.secret && settings.publicKey));

  phase = 'capture unrelated-account count and unchanged budget';
  const initialCount = await countUsers();
  assert(initialCount >= 1);
  const baselineGuard = await request(guardPath, { admin: true });
  assert(baselineGuard.status === 200 && Array.isArray(baselineGuard.body) && baselineGuard.body.length === 1);

  phase = 'create exactly one confirmed disposable user';
  // Deliberately no retries, invitations, recovery links, or sign-up email flow.
  const creation = await request('/auth/v1/admin/users', {
    method: 'POST', admin: true,
    body: { email: qaEmail, password: qaPassword, email_confirm: true, app_metadata: { firstrole_delete_qa_run: runId }, user_metadata: { firstrole_qa: true } },
  });
  const created = creation.body?.user ?? creation.body;
  if (typeof created?.id === 'string' && /^[a-f\d-]{36}$/i.test(created.id)) createdUserId = created.id;
  assert([200, 201].includes(creation.status) && createdUserId && created.email === qaEmail && created.app_metadata?.firstrole_delete_qa_run === runId);
  assert(await countUsers() === initialCount + 1);

  phase = 'sign in only the disposable password account';
  const login = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: qaEmail, password: qaPassword } });
  assert(login.status === 200 && login.body?.user?.id === createdUserId && typeof login.body?.access_token === 'string');
  const token = login.body.access_token;

  phase = 'write one private profile and saved-job fixture';
  let response = await request('/rest/v1/profiles', {
    method: 'POST', token,
    body: { user_id: createdUserId, preferences: { role: 'Private deletion QA', location: 'Private fixture', jobTypes: ['internship'], workplaces: [], keywords: '', sponsorshipRequired: false, postedWithinDays: null } },
  });
  assert(response.status === 201);
  const jobId = `delete-qa-${runId}`;
  const job = {
    id: jobId, title: 'Private account-deletion fixture', company: 'FirstRole QA', location: 'Private fixture',
    workplace: 'unknown', remoteRegion: null, employmentType: 'internship',
    sourceUrl: 'https://example.invalid/private-delete-qa', applyUrl: 'https://example.invalid/private-delete-qa',
    requisitionId: null, description: 'Private temporary fixture. Never searched, fetched, published, or cached.',
    requirements: [], salary: null, postedAt: null, deadline: null, checkedAt: new Date().toISOString(),
    sponsorship: 'not-stated', evidence: [], availability: 'unverified',
    match: { tier: 'Possible match', reasons: [], score: 0 },
  };
  response = await request('/rest/v1/saved_jobs', { method: 'POST', token, body: { user_id: createdUserId, job_id: jobId, job, status: 'Saved', notes: 'Private deletion verification only' } });
  assert(response.status === 201);
  for (const table of ['profiles', 'saved_jobs']) {
    response = await request(rowPath(table, createdUserId), { token });
    assert(response.status === 200 && Array.isArray(response.body) && response.body.length === 1 && response.body[0].user_id === createdUserId);
  }
  // With no search records, this account cannot have provider operations for
  // the deletion endpoint to cancel. No provider request can arise from it.
  response = await request(`/rest/v1/search_runs?owner_id=eq.${createdUserId}&select=id`, { admin: true });
  assert(response.status === 200 && Array.isArray(response.body) && response.body.length === 0);

  phase = 'delete through the actual deployed Worker';
  response = await send(`${workerOrigin}/api/account/delete`, { method: 'POST', headers: { origin: workerOrigin, authorization: `Bearer ${token}` } });
  assert(response.status === 200 && response.body?.ok === true);

  phase = 'verify Auth deletion and private-record cascade';
  response = await request(userPath(createdUserId), { admin: true });
  assert(response.status === 404);
  await assertOwnRowsAbsent();

  phase = 'verify former session rejected by deployed Worker';
  response = await send(`${workerOrigin}/api/account/delete`, { method: 'POST', headers: { origin: workerOrigin, authorization: `Bearer ${token}` } });
  assert(response.status === 401 && response.body?.error?.code === 'INVALID_SESSION');

  phase = 'verify unrelated-account count and budget unchanged';
  assert(await countUsers() === initialCount);
  response = await request(guardPath, { admin: true });
  assert(response.status === 200 && JSON.stringify(response.body) === JSON.stringify(baselineGuard.body));
  completed = true;
} catch {
  // Never log exception objects or server responses: they can contain secrets
  // or user information. A failure leaves a sanitized private recovery record.
  failedPhase = phase;
} finally {
  if (settings && createdUserId) {
    try {
      const readback = await request(userPath(createdUserId), { admin: true });
      if (readback.status === 200) {
        const current = readback.body?.user ?? readback.body;
        assert(current?.id === createdUserId && current.email === qaEmail && current.app_metadata?.firstrole_delete_qa_run === runId);
        const cleanup = await request(userPath(createdUserId), { method: 'DELETE', admin: true });
        assert([200, 204].includes(cleanup.status));
        const absent = await request(userPath(createdUserId), { admin: true });
        assert(absent.status === 404);
      } else assert(readback.status === 404);
      await assertOwnRowsAbsent();
    } catch { cleanupFailed = true; }
  }
}

if (completed && !failedPhase && !cleanupFailed) {
  console.log('PASS');
} else {
  await mkdir(resolve('artifacts/private'), { recursive: true });
  await writeFile(resolve(`artifacts/private/account-delete-check-${runId}.json`), JSON.stringify({ runId, project: expectedProject, failedPhase, cleanupFailed, createdUserId }, null, 2));
  process.exitCode = 1;
}
