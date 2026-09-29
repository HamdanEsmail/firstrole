// Explicitly authorized live RLS check. Creates exactly two temporary confirmed QA
// users, modifies only their account rows, and deletes those users in finally.
// Never calls TinyFish, starts a search, changes a guard, or sends an email.
// Run from the project root: node tests/integration/rls-live.mjs
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const expectedProject = 'abhfpenjfdxvzbjodkqj';
const runId = randomUUID();
const created = [];
let checks = 0;
let phase = 'read local configuration';
let failedPhase = null;
let cleanupFailed = false;
let settings;

function requireCondition(condition) {
  if (!condition) throw new Error('check failed');
  checks++;
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

async function request(path, { method = 'GET', token, admin = false, body, representation = false } = {}) {
  const key = admin ? settings.secret : settings.publicKey;
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (admin) headers.authorization = `Bearer ${settings.secret}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  if (representation) headers.prefer = 'return=representation';
  const response = await fetch(`${settings.origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  if (raw.length > 512 * 1024) throw new Error('response size exceeded');
  let value = null;
  if (raw) { try { value = JSON.parse(raw); } catch { throw new Error('invalid response'); } }
  return { status: response.status, body: value };
}

const ownRows = (table, userId) => `/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}`;
const guardPath = '/rest/v1/budget_guard?select=enabled,limit_usd,spent_usd,reserved_usd&singleton=eq.true';

async function createUser(label) {
  // No retry of the create request: at most one admin create per label.
  const email = `firstrole-qa-${runId}-${label}@example.invalid`;
  const password = `Qa!${randomBytes(36).toString('base64url')}7a`;
  phase = `create confirmed QA account ${label}`;
  const response = await request('/auth/v1/admin/users', {
    method: 'POST', admin: true,
    body: { email, password, email_confirm: true, app_metadata: { firstrole_qa_run: runId }, user_metadata: { firstrole_qa: true } },
  });
  const user = response.body?.user ?? response.body;
  // Save the exact returned ID before any later assertion or login can fail.
  if (typeof user?.id === 'string' && /^[a-f\d-]{36}$/i.test(user.id)) created.push({ id: user.id, email, label });
  requireCondition([200, 201].includes(response.status) && user?.id && user.email === email && created.some(item => item.id === user.id));
  phase = `sign in QA account ${label}`;
  const login = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  requireCondition(login.status === 200 && typeof login.body?.access_token === 'string' && login.body?.user?.id === user.id);
  return { id: user.id, token: login.body.access_token };
}

function fixtureJob(id) {
  return {
    id, title: 'Private QA fixture', company: 'FirstRole account test', location: 'Test fixture',
    workplace: 'unknown', remoteRegion: null, employmentType: 'internship',
    sourceUrl: 'https://example.invalid/private-qa', applyUrl: 'https://example.invalid/private-qa',
    requisitionId: null, description: 'Private temporary test record; never added to search results or cache.',
    requirements: [], salary: null, postedAt: null, deadline: null, checkedAt: new Date().toISOString(),
    sponsorship: 'not-stated', evidence: [], availability: 'unverified',
    match: { tier: 'Possible match', reasons: [], score: 0 },
  };
}

try {
  const vars = parseVars(await readFile(resolve('.dev.vars'), 'utf8'));
  const url = new URL(vars.SUPABASE_URL);
  requireCondition(url.protocol === 'https:' && url.hostname === `${expectedProject}.supabase.co` && !url.username && !url.password && url.pathname === '/');
  settings = { origin: url.origin, publicKey: vars.SUPABASE_PUBLISHABLE_KEY, secret: vars.SUPABASE_SERVICE_ROLE_KEY };
  requireCondition(Boolean(settings.publicKey && settings.secret));
  phase = 'read unchanged guard baseline';
  const baseline = await request(guardPath, { admin: true });
  requireCondition(baseline.status === 200 && Array.isArray(baseline.body) && baseline.body.length === 1);

  const a = await createUser('a');
  const b = await createUser('b');
  requireCondition(created.length === 2 && a.id !== b.id);
  const jobA = `qa-${runId}-a`;
  const jobB = `qa-${runId}-b`;

  phase = 'own profile create read update';
  let result = await request('/rest/v1/profiles', { method: 'POST', token: a.token, body: { user_id: a.id, preferences: { role: 'QA analyst' } }, representation: true });
  requireCondition(result.status === 201 && result.body?.[0]?.user_id === a.id);
  result = await request(ownRows('profiles', a.id), { method: 'PATCH', token: a.token, body: { preferences: { role: 'QA analyst', keywords: 'private fixture' } }, representation: true });
  requireCondition(result.status === 200 && result.body?.[0]?.preferences?.keywords === 'private fixture');
  result = await request(ownRows('profiles', a.id), { token: a.token });
  requireCondition(result.status === 200 && result.body?.length === 1 && result.body[0].user_id === a.id);

  phase = 'own saved job create read update';
  result = await request('/rest/v1/saved_jobs', { method: 'POST', token: a.token, body: { user_id: a.id, job_id: jobA, job: fixtureJob(jobA) }, representation: true });
  requireCondition(result.status === 201 && result.body?.[0]?.job_id === jobA);
  result = await request(ownRows('saved_jobs', a.id), { method: 'PATCH', token: a.token, body: { status: 'Applied', notes: 'Private QA update', applied_at: new Date().toISOString() }, representation: true });
  requireCondition(result.status === 200 && result.body?.[0]?.status === 'Applied' && result.body[0].notes === 'Private QA update');
  result = await request(ownRows('saved_jobs', a.id), { token: a.token });
  requireCondition(result.status === 200 && result.body?.length === 1 && result.body[0].job.id === jobA);

  phase = 'second account owns separate rows';
  result = await request('/rest/v1/profiles', { method: 'POST', token: b.token, body: { user_id: b.id, preferences: { role: 'Second private fixture' } } });
  requireCondition(result.status === 201);
  result = await request('/rest/v1/saved_jobs', { method: 'POST', token: b.token, body: { user_id: b.id, job_id: jobB, job: fixtureJob(jobB) } });
  requireCondition(result.status === 201);

  for (const table of ['profiles', 'saved_jobs']) {
    phase = `${table} cross-account read isolation`;
    result = await request(ownRows(table, a.id), { token: b.token });
    requireCondition(result.status === 200 && Array.isArray(result.body) && result.body.length === 0);
    phase = `${table} cross-account update isolation`;
    result = await request(ownRows(table, a.id), { method: 'PATCH', token: b.token, body: table === 'profiles' ? { preferences: { role: 'forbidden' } } : { notes: 'forbidden' }, representation: true });
    requireCondition(result.status === 200 && Array.isArray(result.body) && result.body.length === 0);
    phase = `${table} cross-account delete isolation`;
    result = await request(ownRows(table, a.id), { method: 'DELETE', token: b.token, representation: true });
    requireCondition(result.status === 200 && Array.isArray(result.body) && result.body.length === 0);
  }
  phase = 'cross-account insert isolation';
  const attackId = `qa-${runId}-forbidden`;
  result = await request('/rest/v1/saved_jobs', { method: 'POST', token: b.token, body: { user_id: a.id, job_id: attackId, job: fixtureJob(attackId) } });
  requireCondition(result.status === 403 && result.body?.code === '42501');
  // A third profile is unnecessary: delete/recreate A's own profile below, then test
  // the forbidden insert while the primary key is free to avoid a duplicate-key result.
  phase = 'ownership transfer rejected';
  result = await request(ownRows('saved_jobs', a.id), { method: 'PATCH', token: a.token, body: { user_id: b.id }, representation: true });
  requireCondition(result.status === 403 && result.body?.code === '42501');
  phase = 'cross-account attempts left owner data unchanged';
  result = await request(ownRows('saved_jobs', a.id), { token: a.token });
  requireCondition(result.status === 200 && result.body?.length === 1 && result.body[0].notes === 'Private QA update');

  phase = 'own profile delete and forbidden replacement';
  result = await request(ownRows('profiles', a.id), { method: 'DELETE', token: a.token, representation: true });
  requireCondition(result.status === 200 && result.body?.length === 1);
  result = await request('/rest/v1/profiles', { method: 'POST', token: b.token, body: { user_id: a.id, preferences: {} } });
  requireCondition(result.status === 403 && result.body?.code === '42501');
  result = await request('/rest/v1/profiles', { method: 'POST', token: a.token, body: { user_id: a.id, preferences: { role: 'Cascade fixture' } } });
  requireCondition(result.status === 201);
  phase = 'own saved job delete and recreate for cascade';
  result = await request(ownRows('saved_jobs', a.id), { method: 'DELETE', token: a.token, representation: true });
  requireCondition(result.status === 200 && result.body?.length === 1);
  result = await request('/rest/v1/saved_jobs', { method: 'POST', token: a.token, body: { user_id: a.id, job_id: jobA, job: fixtureJob(jobA) } });
  requireCondition(result.status === 201);

  for (const [label, token] of [['anonymous', undefined], ['authenticated', a.token]]) {
    phase = `${label} private-table access denied`;
    result = await request('/rest/v1/budget_guard?select=singleton&limit=1', { token });
    requireCondition([401, 403].includes(result.status));
    phase = `${label} service-only RPC access denied`;
    result = await request('/rest/v1/rpc/get_search_cache', { method: 'POST', token, body: { p_fingerprint: `qa-readonly-${runId}` } });
    requireCondition([401, 403].includes(result.status));
  }
  phase = 'guard unchanged after account verification';
  result = await request(guardPath, { admin: true });
  requireCondition(result.status === 200 && JSON.stringify(result.body) === JSON.stringify(baseline.body));
} catch {
  // Deliberately omit response bodies and exception objects; they can contain PII.
  failedPhase = phase;
} finally {
  if (settings) {
    for (const user of [...created].reverse()) {
      try {
        const readback = await request(`/auth/v1/admin/users/${user.id}`, { admin: true });
        const current = readback.body?.user ?? readback.body;
        if (readback.status !== 200 || current?.id !== user.id || current?.email !== user.email || current?.app_metadata?.firstrole_qa_run !== runId) throw new Error('cleanup ownership not verified');
        const deleted = await request(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE', admin: true });
        if (![200, 204].includes(deleted.status)) throw new Error('cleanup delete failed');
        const absent = await request(`/auth/v1/admin/users/${user.id}`, { admin: true });
        requireCondition(absent.status === 404);
        for (const table of ['profiles', 'saved_jobs']) {
          const rows = await request(`${ownRows(table, user.id)}&select=user_id`, { admin: true });
          requireCondition(rows.status === 200 && Array.isArray(rows.body) && rows.body.length === 0);
        }
        user.cleaned = true;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      // IDs only, in an ignored private directory, support exact cleanup without
      // listing or risking unrelated users. Never persist passwords or tokens.
      await mkdir(resolve('artifacts/private'), { recursive: true });
      await writeFile(resolve(`artifacts/private/rls-cleanup-${runId}.json`), JSON.stringify({ runId, project: expectedProject, users: created.filter(user => !user.cleaned).map(user => ({ id: user.id, label: user.label })) }, null, 2));
    }
  }
}

if (!failedPhase && !cleanupFailed && created.length === 2 && created.every(user => user.cleaned)) {
  console.log(`PASS live RLS/account integration: ${checks} checks; two disposable accounts removed; ownership and cascade verified; budget unchanged; no provider calls.`);
} else {
  console.log(`FAIL live RLS/account integration: ${failedPhase || 'cleanup verification'}; cleanup ${cleanupFailed ? 'requires exact-ID recovery from ignored private artifact' : 'completed for every tracked account'}; no provider calls.`);
  process.exitCode = 1;
}
