import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/workflows', () => ({ SearchWorkflow: class {}, AgentWorkflow: class {} }));
vi.mock('../server/enrichment-workflow', () => ({ EnrichmentWorkflow: class {} }));
import worker from '../server/index';
import { readAgentPreview } from '../server/agent-preview';
import { safeAgentPreviewUrl } from '../shared/agent-preview';
import { Database } from '../server/db';
import { TinyFish } from '../server/tinyfish';
import type { Env } from '../server/env';
import type { SearchRun } from '../shared/types';

const previewUrl = 'https://tf-abc123.fra0-tinyfish.unikraft.app/stream/0?token=test-viewer-token';
const origin = 'https://firstrole.example.com';
const runId = '11111111-1111-4111-8111-111111111111';
function run(changes: Partial<SearchRun> = {}): SearchRun {
  return {
    id: runId,
    status: 'extracting',
    stage: 'Reading a career portal',
    preferences: {
      role: 'Engineering',
      location: 'United States',
      keywords: '',
      jobTypes: ['internship'],
      workplaces: [],
      sponsorshipRequired: false,
      postedWithinDays: null,
    },
    results: [],
    sources: [
      {
        name: 'careers.example.com',
        url: 'https://careers.example.com/jobs',
        status: 'extracting',
        count: 0,
      },
    ],
    errors: [],
    cached: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...changes,
  };
}
function activeOperation() {
  return {
    id: 'op1',
    providerRunId: 'provider-run-1',
    claimToken: 'private-claim',
    kind: 'agent',
    state: 'claimed',
    terminalVerified: false,
  };
}
function env(): Env {
  return {
    ASSETS: {},
    SEARCH_WORKFLOW: {},
    AGENT_WORKFLOW: {},
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test-public',
    SUPABASE_SERVICE_ROLE_KEY: 'test-private-server',
    GUEST_COOKIE_SECRET: 'test-preview-cookie-signing-secret-at-least-32-bytes',
    TINYFISH_API_KEY: 'test-private-provider',
    APP_ORIGIN: origin,
  } as unknown as Env;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TinyFish viewer URL allowlist', () => {
  it('accepts only the documented HTTPS viewer namespace and numbered stream path', () => {
    expect(safeAgentPreviewUrl(previewUrl)).toBe(previewUrl);
    expect(
      safeAgentPreviewUrl('https://tf-example-1.aws-eu-west-1-tinyfish.unikraft.app/stream/2'),
    ).toBeTruthy();
    expect(
      safeAgentPreviewUrl(
        'https://ip-203-0-113-10.tetra-data.production.tinyfish.io/tf-11111111-1111-4111-8111-111111111111/stream/0',
      ),
    ).toBeTruthy();
  });
  it.each([
    'http://tf-abc123.fra0-tinyfish.unikraft.app/stream/0',
    'https://tf-abc123.fra0-tinyfish.unikraft.app.evil.example/stream/0',
    'https://evil.example/stream/0',
    'https://tf-abc123.unikraft.app/stream/0',
    'https://user:pass@tf-abc123.fra0-tinyfish.unikraft.app/stream/0',
    'https://tf-abc123.fra0-tinyfish.unikraft.app:443/stream/0',
    'https://tf-abc123.fra0-tinyfish.unikraft.app:8443/stream/0',
    'https://tf-abc123.fra0-tinyfish.unikraft.app/admin',
    'https://tf-abc123.fra0-tinyfish.unikraft.app/stream/0#fragment',
    'javascript:alert(1)',
    'https://ip-203-0-113-10.tetra-data.production.tinyfish.io.evil.example/tf-11111111-1111-4111-8111-111111111111/stream/0',
    'https://ip-999-0-113-10.tetra-data.production.tinyfish.io/tf-11111111-1111-4111-8111-111111111111/stream/0',
    'https://ip-203-0-113-10.tetra-data.production.tinyfish.io/admin',
    'https://ip-203-0-113-10.tetra-data.production.tinyfish.io/stream/0',
    'https://ip-203-0-113-10.tetra-data.production.tinyfish.io:443/tf-11111111-1111-4111-8111-111111111111/stream/0',
    'https://ip-203-0-113-10.tetra-data.production.tinyfish.io/tf-wrong/stream/0',
  ])('rejects unexpected viewer URL %s', (url) => expect(safeAgentPreviewUrl(url)).toBeNull());
});

describe('ephemeral active-run metadata', () => {
  it('uses only the bound Agent ID and leaves the run object untouched', async () => {
    const current = run();
    const snapshot = structuredClone(current);
    const db = { operations: vi.fn().mockResolvedValue([activeOperation()]) };
    const api = {
      getRun: vi.fn().mockResolvedValue({
        run_id: 'provider-run-1',
        status: 'RUNNING',
        streaming_url: previewUrl,
      }),
    };
    expect(await readAgentPreview(current, db, api)).toEqual({
      status: 'live',
      url: previewUrl,
      sourceName: 'careers.example.com',
    });
    expect(api.getRun).toHaveBeenCalledExactlyOnceWith('provider-run-1');
    expect(current).toEqual(snapshot);
    expect(JSON.stringify(current)).not.toContain('test-viewer-token');
  });
  it.each([
    { cached: true },
    { status: 'completed' as const },
    { status: 'cancelled' as const },
    { status: 'reading' as const },
  ])('never reads or returns viewer metadata for %j', async (change) => {
    const db = { operations: vi.fn() };
    const api = { getRun: vi.fn() };
    expect(await readAgentPreview(run(change), db, api)).toEqual({ status: 'ended' });
    expect(db.operations).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])(
    'drops a terminal provider viewer even if supplied: %s',
    async (status) => {
      const db = { operations: vi.fn().mockResolvedValue([activeOperation()]) };
      const api = {
        getRun: vi
          .fn()
          .mockResolvedValue({ run_id: 'provider-run-1', status, streaming_url: previewUrl }),
      };
      expect(await readAgentPreview(run(), db, api)).toEqual({ status: 'ended' });
    },
  );
  it('rejects mismatched provider identity and never fetches an unbound run', async () => {
    const db = { operations: vi.fn().mockResolvedValue([activeOperation()]) };
    const api = {
      getRun: vi
        .fn()
        .mockResolvedValue({ run_id: 'wrong-run', status: 'RUNNING', streaming_url: previewUrl }),
    };
    expect(await readAgentPreview(run(), db, api)).toEqual({ status: 'unavailable' });
    db.operations.mockResolvedValue([{ ...activeOperation(), providerRunId: null }]);
    api.getRun.mockClear();
    expect((await readAgentPreview(run(), db, api)).status).toBe('waiting');
    expect(api.getRun).not.toHaveBeenCalled();
  });
});

describe('preview HTTP ownership boundary', () => {
  async function cookie(environment: Env) {
    return (await worker.fetch(new Request(`${origin}/api/config`), environment)).headers
      .get('set-cookie')!
      .split(';')[0];
  }
  it('returns a no-store view only after an owned run lookup and active-state recheck', async () => {
    const environment = env();
    const session = await cookie(environment);
    const owned = vi.spyOn(Database.prototype, 'get').mockResolvedValue(run());
    const ops = vi.spyOn(Database.prototype, 'operations').mockResolvedValue([activeOperation()]);
    const metadata = vi.spyOn(TinyFish.prototype, 'getRun').mockResolvedValue({
      run_id: 'provider-run-1',
      status: 'RUNNING',
      streaming_url: previewUrl,
    });
    const mutations = vi.spyOn(Database.prototype, 'update');
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${runId}/preview`, { headers: { cookie: session } }),
      environment,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({
      status: 'live',
      url: previewUrl,
      sourceName: 'careers.example.com',
    });
    expect(owned).toHaveBeenCalledTimes(2);
    expect(owned.mock.invocationCallOrder[0]).toBeLessThan(ops.mock.invocationCallOrder[0]);
    expect(owned.mock.invocationCallOrder[1]).toBeGreaterThan(metadata.mock.invocationCallOrder[0]);
    expect(mutations).not.toHaveBeenCalled();
  });
  it('makes no provider or operation lookup for another owner or an expired search', async () => {
    const environment = env();
    const session = await cookie(environment);
    vi.spyOn(Database.prototype, 'get').mockResolvedValue(null);
    const ops = vi.spyOn(Database.prototype, 'operations');
    const metadata = vi.spyOn(TinyFish.prototype, 'getRun');
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${runId}/preview`, { headers: { cookie: session } }),
      environment,
    );
    expect(response.status).toBe(404);
    expect(ops).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('test-viewer-token');
  });
  it('discards a viewer when cancellation happens during its metadata read', async () => {
    const environment = env();
    const session = await cookie(environment);
    vi.spyOn(Database.prototype, 'get')
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: 'cancelled' }));
    vi.spyOn(Database.prototype, 'operations').mockResolvedValue([activeOperation()]);
    vi.spyOn(TinyFish.prototype, 'getRun').mockResolvedValue({
      run_id: 'provider-run-1',
      status: 'RUNNING',
      streaming_url: previewUrl,
    });
    const response = await worker.fetch(
      new Request(`${origin}/api/searches/${runId}/preview`, { headers: { cookie: session } }),
      environment,
    );
    expect(await response.json()).toEqual({ status: 'ended' });
  });
});
