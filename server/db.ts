import type { Job, SearchRun } from '../shared/types';
import { AppError, type Env } from './env';
import { boundedJson } from './http';

export interface InternalRun {
  payload: SearchRun;
  cancelRequested: boolean;
  actorKey: string;
  ownerId: string | null;
  guestId: string | null;
  networkKey: string;
  assisted: boolean;
}
export interface Operation {
  id: string;
  claimToken: string | null;
  providerRunId: string | null;
  state: string;
  kind: string;
}
export interface Reservation {
  allowed: boolean;
  operationId?: string;
  state?: string;
  reason?: string;
  reused?: boolean;
}

export class Database {
  constructor(private env: Env) {}

  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.env.SUPABASE_URL || !this.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new AppError('SETUP_REQUIRED', 'Search storage is not configured yet.', 503);
    const response = await fetch(`${this.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Search storage is temporarily unavailable. Please try again shortly.',
        503,
      );
    }
    return boundedJson<T>(response, 512 * 1024);
  }

  get(id: string, actorKey: string): Promise<SearchRun | null> {
    return this.rpc('get_search_run', { p_run_id: id, p_actor_key: actorKey });
  }
  internal(id: string): Promise<InternalRun | null> {
    return this.rpc('get_internal_search_run', { p_run_id: id });
  }
  update(run: SearchRun): Promise<SearchRun> {
    run.updatedAt = new Date().toISOString();
    return this.rpc('update_search_run', { p_run_id: run.id, p_payload: run });
  }
  operations(id: string): Promise<Operation[]> {
    return this.rpc('list_provider_operations', { p_run_id: id });
  }
  authorizedJob(
    jobId: string,
    actorKey: string,
    searchId: string | null,
    ownerId: string | null,
  ): Promise<Job | null> {
    return this.rpc('get_authorized_job', {
      p_job_id: jobId,
      p_actor_key: actorKey,
      p_search_id: searchId,
      p_owner_id: ownerId,
    });
  }
  reserve(
    runId: string,
    key: string,
    kind: 'search' | 'fetch' | 'agent',
    units = 1,
    host: string | null = null,
  ): Promise<Reservation> {
    return this.rpc('reserve_provider_operation', {
      p_run_id: runId,
      p_operation_key: key,
      p_kind: kind,
      p_units: units,
      p_source_host: host,
    });
  }
  claim(
    operationId: string,
    token: string,
  ): Promise<{ claimed: boolean; state: string; providerRunId?: string; claimToken?: string }> {
    return this.rpc('claim_provider_operation', {
      p_operation_id: operationId,
      p_claim_token: token,
    });
  }
  bind(operationId: string, token: string, providerRunId: string): Promise<boolean> {
    return this.rpc('bind_provider_run', {
      p_operation_id: operationId,
      p_claim_token: token,
      p_provider_run_id: providerRunId,
    });
  }
  async settle(
    operationId: string,
    token: string,
    outcome: string,
    terminalVerified = false,
  ): Promise<void> {
    // Never release dollars using step-count estimates: billing settlement is not exposed by the documented API.
    await this.rpc('settle_provider_operation', {
      p_operation_id: operationId,
      p_claim_token: token,
      p_outcome: outcome,
      p_actual_usd: null,
      p_authoritative: false,
      p_terminal_verified: terminalVerified,
    });
  }
  async rejectBeforeStart(operationId: string, token: string): Promise<void> {
    await this.rpc('settle_provider_operation', {
      p_operation_id: operationId,
      p_claim_token: token,
      p_outcome: 'not-started',
      p_actual_usd: 0,
      p_authoritative: true,
      p_terminal_verified: true,
    });
  }
}

export function admissionError(reason?: string): AppError {
  const reasons: Record<string, string> = {
    budget_exhausted:
      'The public pilot has reached its spending limit. Saved and cached results are still available.',
    actor_daily_limit:
      'You have reached today’s live search limit. Try a recent search or return tomorrow.',
    network_daily_limit:
      'This network has reached today’s live search limit. Please try again tomorrow.',
    actor_assisted_limit: 'Your browser-assisted search allowance has been used today.',
    network_assisted_limit:
      'The browser-assisted search allowance for this network has been used today.',
    agent_concurrency: 'Both browser agents are busy. Please try again shortly.',
    global_agent_concurrency:
      'Both browser agents are busy. Available directly readable listings are preserved.',
    global_agent_daily_limit:
      'The pilot’s browser-assisted allowance has been used today. Directly readable listings are preserved.',
    source_concurrency: 'This career site is already being checked. Please try again shortly.',
    source_agent_concurrency:
      'This career site is already being checked. Other available listings are preserved.',
  };
  return new AppError(
    reason?.toUpperCase() || 'SEARCH_LIMIT',
    reasons[reason ?? ''] ||
      'The live search allowance is temporarily unavailable. Please try a recent search or return later.',
    429,
  );
}
