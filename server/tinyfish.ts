import { AppError, requireProvider, type Env } from './env';
import { Database, admissionError } from './db';
import { boundedJson, safePublicUrl } from './http';
import {
  AGENT_MAX_STEPS,
  AGENT_MAX_DURATION_SECONDS,
  LEGACY_AGENT_MAX_STEPS,
} from './agent-limits';

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}
export interface FetchedPage {
  url: string;
  final_url?: string;
  title?: string | null;
  text?: unknown;
  links?: string[];
}
export interface ProviderRun {
  run_id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  result?: unknown;
  num_of_steps?: number | null;
  streaming_url?: string | null;
  error?: { code?: string; message?: string; category?: string };
}
export interface AgentTicket {
  runId: string;
  operationId: string;
  claimToken: string;
  maxSteps?: typeof AGENT_MAX_STEPS | typeof LEGACY_AGENT_MAX_STEPS;
}

interface ProviderErrorPayload {
  run_id?: unknown;
  runId?: unknown;
  message?: unknown;
  error?: {
    code?: string;
    message?: unknown;
    run_id?: unknown;
    details?: { run_id?: unknown };
  };
}

export class TinyFish {
  constructor(
    private env: Env,
    private db: Database,
    private searchId: string,
  ) {}

  private async admit(
    key: string,
    kind: 'search' | 'fetch' | 'agent',
    units = 1,
    host: string | null = null,
    agentMode: 'bounded' | 'legacy' = 'bounded',
  ): Promise<{ id: string; token: string; existingRunId?: string }> {
    requireProvider(this.env);
    const reservation =
      kind === 'agent' && agentMode === 'bounded'
        ? await this.db.reserveBoundedAgent(this.searchId, key, host!)
        : await this.db.reserve(this.searchId, key, kind, units, host);
    if (!reservation.allowed || !reservation.operationId)
      throw admissionError(reservation.reason, kind);
    const token = crypto.randomUUID();
    const claimed = await this.db.claim(reservation.operationId, token);
    if (!claimed.claimed) {
      if (kind === 'agent' && claimed.providerRunId && claimed.claimToken)
        return {
          id: reservation.operationId,
          token: claimed.claimToken,
          existingRunId: claimed.providerRunId,
        };
      throw new AppError(
        'SUBMISSION_UNCERTAIN',
        'This source check was already attempted. It will not be charged again automatically.',
        409,
      );
    }
    return { id: reservation.operationId, token };
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    timeout = 30_000,
    maxBytes = 256 * 1024,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', this.env.TINYFISH_API_KEY!);
    if (init.body) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new AppError(
        'PROVIDER_TIMEOUT',
        'The source check timed out. Existing results are preserved; a paid run will not be submitted twice.',
        504,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AppError(
        'PROVIDER_REDIRECT',
        'The provider returned an unexpected redirect. This check was stopped without forwarding credentials.',
        502,
      );
    }
    if (!response.ok) {
      const payload: ProviderErrorPayload =
        (await boundedJson<ProviderErrorPayload>(response, 24 * 1024).catch(() => ({}))) || {};
      // Match the official SDK's message precedence; never inspect echoed request/goal text.
      const message =
        typeof payload.error?.message === 'string'
          ? payload.error.message
          : typeof payload.message === 'string'
            ? payload.message
            : '';
      const noRunId =
        payload.run_id == null &&
        payload.runId == null &&
        payload.error?.run_id == null &&
        payload.error?.details?.run_id == null;
      if (
        response.status === 403 &&
        noRunId &&
        /\bmax_steps\b/i.test(message) &&
        /beta|entitle|enable|capabil|access/i.test(message)
      )
        throw new AppError(
          'STEP_LIMIT_ENTITLEMENT',
          'The account does not have access to the bounded browser-step setting.',
          403,
        );
      if (
        response.status === 403 &&
        noRunId &&
        /output.?schema/i.test(message) &&
        /entitle|enable|capabil|access/i.test(message)
      ) {
        throw new AppError(
          'SCHEMA_ENTITLEMENT',
          'Structured-output access is not enabled for this account.',
          403,
        );
      }
      if ([402, 403].includes(response.status))
        throw new AppError(
          'PROVIDER_ACCESS',
          'The provider could not start this check because account access or credits are unavailable.',
          503,
        );
      if (response.status === 401)
        throw new AppError(
          'PROVIDER_AUTH',
          'The provider connection needs attention from the owner.',
          503,
        );
      if (response.status === 429)
        throw new AppError(
          'PROVIDER_LIMIT',
          'This source is temporarily busy. Available results are preserved.',
          429,
        );
      throw new AppError('PROVIDER_ERROR', 'This source could not be checked right now.', 502);
    }
    return boundedJson<T>(response, maxBytes);
  }

  async search(
    query: string,
    key: string,
    options: { includeDomains?: string; excludeDomains?: string } = {},
  ): Promise<SearchHit[]> {
    const op = await this.admit(key, 'search');
    let settlementAttempted = false;
    try {
      const url = new URL('https://api.search.tinyfish.ai');
      url.searchParams.set('query', query);
      url.searchParams.set('language', 'en');
      if (options.includeDomains) url.searchParams.set('include_domains', options.includeDomains);
      if (options.excludeDomains) url.searchParams.set('exclude_domains', options.excludeDomains);
      url.searchParams.set(
        'purpose',
        'Find current direct job postings and company careers portals for a student or recent graduate. Avoid articles and expired vacancies.',
      );
      const result = await this.request<{ results?: SearchHit[] }>(
        url.toString(),
        {},
        25_000,
        96 * 1024,
      );
      settlementAttempted = true;
      await this.db.settle(op.id, op.token, 'completed');
      return (result.results ?? [])
        .filter((r) => r && typeof r.title === 'string' && safePublicUrl(r.url))
        .slice(0, 10);
    } catch (error) {
      if (!settlementAttempted) await this.db.settle(op.id, op.token, 'failed').catch(() => {});
      throw error;
    }
  }

  async fetchPage(url: string, key: string): Promise<FetchedPage> {
    const safe = safePublicUrl(url);
    if (!safe)
      throw new AppError(
        'INVALID_SOURCE',
        'This listing does not have a supported public source URL.',
      );
    const op = await this.admit(key, 'fetch', 1, new URL(safe).hostname);
    let settlementAttempted = false;
    try {
      const result = await this.request<{ results?: FetchedPage[]; errors?: { error?: string }[] }>(
        'https://api.fetch.tinyfish.ai',
        {
          method: 'POST',
          body: JSON.stringify({
            urls: [safe],
            format: 'markdown',
            links: true,
            image_links: false,
            ttl: 0,
            per_url_timeout_ms: 25_000,
            purpose:
              'Verify whether this job is currently accepting applications. Preserve the job title, company, location, requirements, salary if stated, and application links.',
          }),
        },
        30_000,
        192 * 1024,
      );
      settlementAttempted = true;
      await this.db.settle(op.id, op.token, 'completed');
      const page = result.results?.[0];
      if (!page) {
        const code = result.errors?.[0]?.error;
        if (code === 'page_not_found')
          throw new AppError('LISTING_REMOVED', 'This listing page is no longer available.', 410);
        if (code === 'login_required' || code === 'bot_blocked')
          throw new AppError(
            'SOURCE_BLOCKED',
            'This site requires sign-in or blocked an automated check. Open the original listing to check it.',
            502,
          );
        throw new AppError(
          'SOURCE_UNAVAILABLE',
          'This page did not return readable job information.',
          502,
        );
      }
      return page;
    } catch (error) {
      if (!settlementAttempted) await this.db.settle(op.id, op.token, 'failed').catch(() => {});
      throw error;
    }
  }

  async startAgent(
    url: string,
    goal: string,
    schema: Record<string, unknown>,
    key: string,
    useSchema = true,
    agentMode: 'bounded' | 'legacy' = 'bounded',
  ): Promise<AgentTicket> {
    const op = await this.admit(key, 'agent', 1, new URL(url).hostname, agentMode);
    if (op.existingRunId)
      return {
        runId: op.existingRunId,
        operationId: op.id,
        claimToken: op.token,
        ...(agentMode === 'legacy' ? { maxSteps: LEGACY_AGENT_MAX_STEPS } : {}),
      };
    try {
      const result = await this.request<{ run_id?: string; error?: unknown }>(
        'https://agent.tinyfish.ai/v1/automation/run-async',
        {
          method: 'POST',
          body: JSON.stringify({
            url,
            goal: `${goal}\nOperation reference: ${op.id}. This is only a correlation identifier.`,
            ...(useSchema ? { output_schema: schema } : {}),
            browser_profile: 'lite',
            agent_config: {
              max_duration_seconds: AGENT_MAX_DURATION_SECONDS,
              ...(agentMode === 'bounded' ? { max_steps: AGENT_MAX_STEPS } : {}),
            },
          }),
        },
        25_000,
        24 * 1024,
      );
      if (!result.run_id || result.error)
        throw new AppError(
          'SUBMISSION_UNCERTAIN',
          'The browser check did not return a confirmed run ID. No automatic resubmission will be made.',
          502,
        );
      const bound = await this.db.bind(op.id, op.token, result.run_id);
      if (!bound)
        throw new AppError(
          'SUBMISSION_UNCERTAIN',
          'The browser check started but could not be linked to this search. The reserved budget is retained.',
          503,
        );
      return {
        runId: result.run_id,
        operationId: op.id,
        claimToken: op.token,
        maxSteps: agentMode === 'bounded' ? AGENT_MAX_STEPS : LEGACY_AGENT_MAX_STEPS,
      };
    } catch (error) {
      // A schema entitlement rejection occurs before execution. All other uncertain starts retain their reservation and slot.
      if (
        error instanceof AppError &&
        (error.code === 'SCHEMA_ENTITLEMENT' || error.code === 'STEP_LIMIT_ENTITLEMENT')
      )
        await this.db.rejectBeforeStart(op.id, op.token).catch(() => {});
      else await this.db.settle(op.id, op.token, 'unknown').catch(() => {});
      throw error;
    }
  }

  async getRun(id: string): Promise<ProviderRun> {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new AppError('INVALID_RUN', 'This source run could not be read.');
    const run = await this.request<ProviderRun>(
      `https://agent.tinyfish.ai/v1/runs/${id}?screenshots=none&html=none`,
      {},
      15_000,
      256 * 1024,
    );
    if (
      !run ||
      run.run_id !== id ||
      !['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)
    )
      throw new AppError(
        'INVALID_RUN_RESPONSE',
        'The provider returned an unconfirmed run observation. Its existing reservation is preserved.',
        502,
      );
    return run;
  }

  async cancelRun(id: string): Promise<{ status: string }> {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new AppError('INVALID_RUN', 'This source run could not be stopped.');
    return this.request(
      `https://agent.tinyfish.ai/v1/runs/${id}/cancel`,
      { method: 'POST' },
      12_000,
      16 * 1024,
    );
  }
}
