import type { Job, PublicConfig, SearchRun } from '../shared/types';
import { DEFAULT_PREFERENCES } from '../shared/types';
import { AppError, databaseReady, providerReady, requireProvider, type Env } from './env';
import { checkOrigin, identify, pseudonym, type Owner } from './auth';
import { Database, admissionError, type Operation } from './db';
import { json, requestJson, safeMessage, sha256 } from './http';
import { fingerprintInput, validatePreferences, verifyJob } from './quality';
import { TinyFish } from './tinyfish';

export { SearchWorkflow, AgentWorkflow } from './workflows';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const TERMINAL = new Set<SearchRun['status']>(['completed', 'partial', 'failed', 'cancelled']);

function presentRun(run: SearchRun): SearchRun {
  if (!run.cached || !run.results.length) return run;
  const times = run.results.map((job) => Date.parse(job.checkedAt)).filter(Number.isFinite);
  return times.length ? { ...run, updatedAt: new Date(Math.min(...times)).toISOString() } : run;
}

function newRun(preferences: SearchRun['preferences']): SearchRun {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    status: 'queued',
    stage: 'Preparing your search.',
    preferences,
    sources: [],
    results: [],
    errors: [],
    cached: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function createOwnedRun(
  db: Database,
  env: Env,
  request: Request,
  owner: Owner,
  run: SearchRun,
  fingerprint: string,
  assisted: boolean,
  idempotency: string,
): Promise<{ run: SearchRun; reused: boolean }> {
  const actorKey = await pseudonym(owner.key, env);
  const networkKey = await pseudonym(
    `network:${request.headers.get('cf-connecting-ip') || 'local-development'}`,
    env,
  );
  const parameters = {
    p_run_id: run.id,
    p_actor_key: actorKey,
    p_owner_id: owner.userId,
    p_guest_id: owner.guestId,
    p_network_key: networkKey,
    p_fingerprint: fingerprint,
    p_payload: run,
    p_assisted: assisted,
    p_idempotency_key: idempotency,
  };
  let result = await db.rpc<{
    admitted: boolean;
    run?: SearchRun;
    reason?: string;
    reused?: boolean;
  }>('create_search_run', parameters);
  if (
    !result.admitted &&
    assisted &&
    ['actor_assisted_limit', 'network_assisted_limit'].includes(result.reason ?? '')
  ) {
    run.stage =
      'Searching directly readable sources. The browser-assisted allowance is already used today.';
    run.errors.push({
      message:
        'This search checks directly readable listings; today’s browser-assisted allowance is already used.',
    });
    result = await db.rpc('create_search_run', {
      ...parameters,
      p_assisted: false,
      p_payload: run,
    });
  }
  if (!result.admitted || !result.run) throw admissionError(result.reason);
  return { run: result.run, reused: Boolean(result.reused) };
}

async function stopOperations(
  db: Database,
  env: Env,
  searchId: string,
  operations: Operation[],
): Promise<boolean> {
  const api = new TinyFish(env, db, searchId);
  let confirmed = true;
  for (const operation of operations.filter((o) => o.kind === 'agent' && o.state !== 'settled')) {
    if (!operation.providerRunId || !operation.claimToken) {
      confirmed = false;
      continue;
    }
    try {
      const stopped = await api.cancelRun(operation.providerRunId);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(stopped.status))
        await db.settle(operation.id, operation.claimToken, stopped.status.toLowerCase(), true);
      else confirmed = false;
    } catch {
      confirmed = false;
    }
  }
  return confirmed;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    let owner: Owner | null = null;
    try {
      if (request.method === 'GET' && url.pathname === '/api/config') {
        const config: PublicConfig = {
          supabaseUrl: env.SUPABASE_URL || '',
          supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || '',
          searchEnabled: providerReady(env),
          googleEnabled: env.GOOGLE_AUTH_ENABLED === 'true' && databaseReady(env),
          ...(!providerReady(env)
            ? {
                setupMessage: databaseReady(env)
                  ? 'Live searches are paused while the owner checks the pilot allowance. Your saved jobs remain available.'
                  : 'FirstRole is being connected to its live sources. You can set your preferences and explore the workspace.',
              }
            : {}),
        };
        return json(config);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
      if (!databaseReady(env))
        throw new AppError(
          'SETUP_REQUIRED',
          'Live search is not configured yet. Your preferences can still be saved in this browser.',
          503,
        );
      if (request.method !== 'GET') checkOrigin(request, env);
      owner = await identify(request, env, url.pathname === '/api/account/delete');
      const db = new Database(env);
      const actorKey = await pseudonym(owner.key, env);
      const headers: HeadersInit = owner.cookie ? { 'set-cookie': owner.cookie } : {};

      if (request.method === 'POST' && url.pathname === '/api/searches') {
        const body = await requestJson(request);
        const preferences = validatePreferences(body.preferences);
        const idempotency = request.headers.get('idempotency-key');
        if (!idempotency || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotency))
          throw new AppError(
            'IDEMPOTENCY_REQUIRED',
            'Please start this search again from the search form.',
          );
        const fingerprint = await sha256(fingerprintInput(preferences));
        const cached =
          body.forceRefresh === true
            ? null
            : await db.rpc<Pick<SearchRun, 'results' | 'sources' | 'errors'> | null>(
                'get_search_cache',
                { p_fingerprint: fingerprint },
              );
        const candidate = newRun(preferences);
        if (cached) {
          candidate.results = cached.results;
          candidate.sources = cached.sources;
          candidate.errors = cached.errors;
          candidate.status = 'completed';
          candidate.stage =
            'Recent results reused from the last 6 hours. Original check times are preserved.';
          candidate.cached = true;
        } else requireProvider(env);
        const admitted = await createOwnedRun(
          db,
          env,
          request,
          owner,
          candidate,
          fingerprint,
          !cached,
          idempotency,
        );
        if (!admitted.run.cached && !TERMINAL.has(admitted.run.status)) {
          // Safe on replay: deterministic instance ID plus idempotent createBatch.
          await env.SEARCH_WORKFLOW.createBatch([
            { id: admitted.run.id, params: { searchId: admitted.run.id } },
          ]);
        }
        return json(presentRun(admitted.run), admitted.run.cached ? 200 : 202, headers);
      }

      const searchMatch = url.pathname.match(/^\/api\/searches\/([^/]+)(\/cancel)?$/);
      if (searchMatch) {
        const id = searchMatch[1];
        if (!UUID.test(id)) throw new AppError('NOT_FOUND', 'This search could not be found.', 404);
        const run = await db.get(id, actorKey);
        if (!run)
          throw new AppError(
            'NOT_FOUND',
            'This search has expired or belongs to another browser. Start a new search to continue.',
            404,
          );
        if (request.method === 'GET' && !searchMatch[2]) return json(presentRun(run), 200, headers);
        if (request.method === 'POST' && searchMatch[2]) {
          if (!TERMINAL.has(run.status)) {
            await db.rpc('request_search_cancel', { p_run_id: id, p_actor_key: actorKey });
            const stopped = await stopOperations(db, env, id, await db.operations(id));
            run.status = 'cancelled';
            run.stage = stopped
              ? 'Search stopped. Results already found remain available.'
              : 'Search stopped. A provider check is still being reconciled; no additional work will be started.';
            await db.update(run);
          }
          return json(run, 200, headers);
        }
      }

      const refreshMatch = url.pathname.match(/^\/api\/jobs\/([a-f\d]{64})\/refresh$/i);
      if (request.method === 'POST' && refreshMatch) {
        const body = await requestJson(request);
        const searchId =
          typeof body.searchId === 'string' && UUID.test(body.searchId) ? body.searchId : null;
        const job = await db.authorizedJob(refreshMatch[1], actorKey, searchId, owner.userId);
        if (!job)
          throw new AppError(
            'NOT_FOUND',
            'Search again to recheck this older guest listing, or sign in and import it to your account.',
            404,
          );
        requireProvider(env);
        const preferences = searchId ? (await db.get(searchId, actorKey))?.preferences : null;
        const run = newRun(
          preferences || {
            ...DEFAULT_PREFERENCES,
            role: job.title,
            location: job.location,
            jobTypes: ['internship', 'graduate', 'entry-level'],
          },
        );
        run.status = 'verifying';
        run.stage = 'Rechecking the original listing.';
        const idempotency =
          request.headers.get('idempotency-key') ||
          `refresh-${job.id.slice(0, 32)}-${Math.floor(Date.now() / 60_000)}`;
        const admitted = await createOwnedRun(
          db,
          env,
          request,
          owner,
          run,
          await sha256(`refresh:${job.id}`),
          false,
          idempotency,
        );
        if (admitted.reused) {
          if (admitted.run.results[0]) return json(admitted.run.results[0], 200, headers);
          throw new AppError(
            'REFRESH_IN_PROGRESS',
            'This listing is already being refreshed. Try again in a moment.',
            409,
          );
        }
        const api = new TinyFish(env, db, admitted.run.id);
        let refreshed: Job;
        try {
          refreshed = verifyJob(
            job,
            await api.fetchPage(job.sourceUrl, 'refresh-original'),
            admitted.run.preferences,
          );
        } catch (error) {
          if (error instanceof AppError && error.code === 'LISTING_REMOVED')
            refreshed = { ...job, availability: 'closed', checkedAt: new Date().toISOString() };
          else {
            refreshed = {
              ...job,
              availability: 'unverified',
              checkedAt: new Date().toISOString(),
              match: {
                ...job.match,
                tier: 'Possible match',
                score: Math.min(job.match.score, 54),
                reasons: [
                  'Latest check could not confirm availability',
                  ...job.match.reasons,
                ].slice(0, 5),
              },
            };
            admitted.run.results = [refreshed];
            admitted.run.status = 'partial';
            admitted.run.stage = safeMessage(error);
            admitted.run.errors.push({ source: job.sourceUrl, message: safeMessage(error) });
            await db.update(admitted.run);
            return json(refreshed, 200, headers);
          }
        }
        admitted.run.results = [refreshed];
        admitted.run.status = 'completed';
        admitted.run.stage = 'Listing refreshed.';
        await db.update(admitted.run);
        return json(refreshed, 200, headers);
      }

      if (request.method === 'POST' && url.pathname === '/api/account/delete' && owner.userId) {
        await db.rpc('cancel_user_searches', { p_owner_id: owner.userId });
        const operations = await db.rpc<(Operation & { runId: string })[]>(
          'get_user_provider_operations',
          { p_owner_id: owner.userId },
        );
        for (const operation of operations)
          if (operation.runId) await stopOperations(db, env, operation.runId, [operation]);
        const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${owner.userId}`, {
          method: 'DELETE',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
            authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new AppError(
            'DELETE_FAILED',
            'Your account could not be deleted yet. Please try again shortly.',
            503,
          );
        await response.body?.cancel();
        return json({ ok: true }, 200, {
          'set-cookie': 'firstrole_guest=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
        });
      }
      throw new AppError('NOT_FOUND', 'This request could not be found.', 404);
    } catch (error) {
      const known = error instanceof AppError;
      return json(
        {
          error: {
            code: known ? error.code : 'SERVICE_UNAVAILABLE',
            message: known
              ? error.message
              : 'Something interrupted this request. Please try again shortly.',
          },
        },
        known ? error.status : 503,
        owner?.cookie ? { 'set-cookie': owner.cookie } : {},
      );
    }
  },
} satisfies ExportedHandler<Env>;
