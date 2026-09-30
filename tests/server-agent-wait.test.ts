import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAgent, type AgentWaitIO } from '../server/agent-wait';
import { startGuardedAgent } from '../server/agent-start';
import { agentVerificationTargets } from '../server/search-state';
import { finishOrHandoffSearch } from '../server/workflow-finalization';
import { Database } from '../server/db';
import { TinyFish } from '../server/tinyfish';
import { verifiedRateSnapshot } from '../server/rates';
import { verifyJob } from '../server/quality';
import type { Env } from '../server/env';
import type { Job, SearchRun } from '../shared/types';

function ioFixture() {
  let elapsed = 0;
  const io: AgentWaitIO = {
    sleep: vi.fn(async (_name, seconds) => {
      elapsed += seconds;
    }),
    checkpoint: vi.fn(async (_name, callback) => callback()),
    cancellationRequested: vi.fn(async () => false),
    read: vi.fn(async () => ({ run_id: 'run-1', status: 'RUNNING' as const })),
    cancel: vi.fn(async () => ({ status: 'CANCELLED' })),
  };
  return { io, elapsed: () => elapsed };
}
afterEach(() => vi.unstubAllGlobals());

describe('durable bounded Agent wait', () => {
  it('preserves the native result field when the first scheduled read completes', async () => {
    const fixture = ioFixture();
    vi.mocked(fixture.io.read).mockResolvedValue({
      run_id: 'run-1',
      status: 'COMPLETED',
      result: { jobs: [{ title: 'Engineering Intern' }], note: '' },
      num_of_steps: 4,
    });
    const result = await waitForAgent(fixture.io);
    expect(JSON.parse(result.resultText).jobs[0].title).toBe('Engineering Intern');
    expect(fixture.elapsed()).toBe(60);
    expect(result.observedRunId).toBe('run-1');
    expect(result.numOfSteps).toBe(4);
    expect(fixture.io.cancellationRequested).toHaveBeenCalledTimes(1);
    expect(fixture.io.cancel).not.toHaveBeenCalled();
  });
  it('reads reported terminal counts once after user cancellation when accounting is enabled', async () => {
    const fixture = ioFixture();
    fixture.io.readTerminalUsage = true;
    vi.mocked(fixture.io.cancellationRequested).mockResolvedValue(true);
    vi.mocked(fixture.io.read).mockResolvedValue({
      run_id: 'actual-provider-id',
      status: 'CANCELLED',
      num_of_steps: 0,
    });
    const result = await waitForAgent(fixture.io);
    expect(result).toMatchObject({
      cancelledByUser: true,
      status: 'CANCELLED',
      observedRunId: 'actual-provider-id',
      numOfSteps: 0,
    });
    expect(fixture.io.cancel).toHaveBeenCalledOnce();
    expect(fixture.io.read).toHaveBeenCalledOnce();
  });
  it('allows eight minutes of startup/waiting without increasing the eight scheduled provider reads', async () => {
    const fixture = ioFixture();
    for (let i = 0; i < 7; i++)
      vi.mocked(fixture.io.read).mockResolvedValueOnce({ run_id: 'run-1', status: 'PENDING' });
    vi.mocked(fixture.io.read).mockResolvedValueOnce({
      run_id: 'run-1',
      status: 'COMPLETED',
      result: { jobs: [] },
    });
    expect((await waitForAgent(fixture.io)).status).toBe('COMPLETED');
    expect(fixture.elapsed()).toBe(480);
    expect(fixture.io.read).toHaveBeenCalledTimes(8);
    expect(fixture.io.cancellationRequested).toHaveBeenCalledTimes(8);
    expect(fixture.io.cancel).not.toHaveBeenCalled();
  });
  it('checks cancellation at the thirty-second midpoint before another provider read', async () => {
    const fixture = ioFixture();
    vi.mocked(fixture.io.cancellationRequested).mockResolvedValue(true);
    expect(await waitForAgent(fixture.io)).toMatchObject({
      status: 'CANCELLED',
      cancelledByUser: true,
      timedOut: false,
    });
    expect(fixture.elapsed()).toBe(30);
    expect(fixture.io.read).not.toHaveBeenCalled();
    expect(fixture.io.cancel).toHaveBeenCalledOnce();
  });
  it('retrieves an existing result when cancellation races with completion', async () => {
    const fixture = ioFixture();
    for (let i = 0; i < 8; i++)
      vi.mocked(fixture.io.read).mockResolvedValueOnce({ run_id: 'run-1', status: 'RUNNING' });
    vi.mocked(fixture.io.read).mockResolvedValueOnce({
      run_id: 'run-1',
      status: 'COMPLETED',
      result: { jobs: [{ title: 'Recovered opening' }] },
    });
    vi.mocked(fixture.io.cancel).mockResolvedValue({ status: 'COMPLETED' });
    const result = await waitForAgent(fixture.io);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.resultText).jobs[0].title).toBe('Recovered opening');
    expect(fixture.io.read).toHaveBeenCalledTimes(9); // Eight polls plus one terminal-result recovery.
    expect(fixture.io.cancel).toHaveBeenCalledOnce();
  });
  it('bounds metadata-read failures and never exposes a resubmission operation', async () => {
    const fixture = ioFixture();
    vi.mocked(fixture.io.read).mockRejectedValue(new Error('temporary read failure'));
    expect(await waitForAgent(fixture.io)).toMatchObject({ status: 'CANCELLED', timedOut: true });
    expect(fixture.io.read).toHaveBeenCalledTimes(8);
    expect(fixture.io.cancel).toHaveBeenCalledOnce();
  });
});

const url = 'https://careers.example.com/jobs/engineering-intern';
const job: Job = {
  id: 'a'.repeat(64),
  title: 'Engineering Intern',
  company: 'Example',
  location: 'United States',
  workplace: 'unknown',
  remoteRegion: null,
  employmentType: 'internship',
  sourceUrl: url,
  applyUrl: url,
  requisitionId: null,
  description: 'Build software.',
  requirements: [],
  salary: null,
  postedAt: null,
  deadline: null,
  checkedAt: new Date().toISOString(),
  sponsorship: 'not-stated',
  evidence: [{ field: 'title', text: 'Engineering Intern', sourceUrl: url }],
  availability: 'unverified',
  match: { score: 0, tier: 'Possible match', reasons: [] },
};

it('verifies at most the new Agent opening, not existing Fetch results or already-open duplicates', () => {
  expect(agentVerificationTargets([job], [{ ...job, availability: 'open' }])).toEqual([]);
  expect(agentVerificationTargets([job, { ...job, id: 'b'.repeat(64) }], [])).toEqual([job]);
});

describe('actual adapter HTTP request envelope', () => {
  it.each([
    {
      name: 'direct',
      handoff: false,
      failHandoff: false,
      failedTerminalWrites: 0,
      failCache: false,
      expected: 43,
      outcome: 'finished',
    },
    {
      name: 'terminal update retry',
      handoff: false,
      failHandoff: false,
      failedTerminalWrites: 1,
      failCache: false,
      expected: 44,
      outcome: 'finished',
    },
    {
      name: 'cache failure',
      handoff: false,
      failHandoff: false,
      failedTerminalWrites: 0,
      failCache: true,
      expected: 43,
      outcome: 'finished',
    },
    {
      name: 'successful optional handoff',
      handoff: true,
      failHandoff: false,
      failedTerminalWrites: 0,
      failCache: false,
      expected: 43,
      outcome: 'handed-off',
    },
    {
      name: 'handoff transport failure',
      handoff: true,
      failHandoff: true,
      failedTerminalWrites: 0,
      failCache: false,
      expected: 44,
      outcome: 'finished',
    },
    {
      name: 'handoff failure and first final update failure',
      handoff: true,
      failHandoff: true,
      failedTerminalWrites: 1,
      failCache: false,
      expected: 45,
      outcome: 'finished',
    },
    {
      name: 'handoff failure and both final updates fail',
      handoff: true,
      failHandoff: true,
      failedTerminalWrites: 2,
      failCache: false,
      expected: 45,
      outcome: 'storage-unavailable',
    },
  ])(
    'stays below50 with startup retry, both capability rejections, terminal race and $name',
    async ({ handoff, failHandoff, failedTerminalWrites, failCache, expected, outcome }) => {
      const env = {
        ASSETS: {},
        SEARCH_WORKFLOW: {},
        AGENT_WORKFLOW: {},
        SUPABASE_URL: 'https://db.example.com',
        SUPABASE_PUBLISHABLE_KEY: 'test-public',
        SUPABASE_SERVICE_ROLE_KEY: 'test-server',
        GUEST_COOKIE_SECRET: 'test-secret-at-least-thirty-two-bytes',
        TINYFISH_API_KEY: 'test-provider',
        TINYFISH_ENABLED: 'true',
        TINYFISH_RATES_VERIFIED_AT: new Date().toISOString(),
        TINYFISH_AGENT_RATE: '0.016',
        TINYFISH_SEARCH_RATE: '0.005',
        TINYFISH_FETCH_RATE: '0.001',
      } as unknown as Env;
      const run: SearchRun = {
        id: crypto.randomUUID(),
        status: 'extracting',
        stage: 'Checking source',
        preferences: {
          role: 'Engineering',
          location: 'United States',
          jobTypes: ['internship'],
          workplaces: [],
          keywords: '',
          sponsorshipRequired: false,
          postedWithinDays: null,
        },
        sources: [],
        results: [],
        errors: [],
        cached: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      let internalReads = 0,
        starts = 0,
        polls = 0,
        updates = 0,
        reservations = 0;
      const send = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const outbound = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (target.hostname === 'db.example.com') {
          const name = target.pathname.split('/').at(-1);
          if (name === 'get_internal_search_run') {
            internalReads++;
            if (internalReads === 1) return send({}, 503);
            return send({ payload: run, cancelRequested: false });
          }
          if (name === 'get_provider_rate_attestation')
            return send({
              state: 'verified',
              keyFingerprint: JSON.parse(String(init?.body)).p_key_fingerprint,
              providerAsOf: new Date().toISOString(),
              verifiedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
              agentRate: '0.016',
              searchRate: '0.005',
              fetchRate: '0.001',
            });
          if (name === 'reserve_provider_operation' || name === 'reserve_bounded_agent_operation')
            return send({ allowed: true, operationId: `op-${++reservations}` });
          if (name === 'claim_provider_operation') return send({ claimed: true, state: 'claimed' });
          if (name === 'bind_provider_run') return send(true);
          if (name === 'settle_provider_operation') return send({ settled: true });
          if (name === 'update_search_run') {
            updates++;
            const firstTerminalUpdate = handoff ? 4 : 3;
            if (
              updates >= firstTerminalUpdate &&
              updates < firstTerminalUpdate + failedTerminalWrites
            )
              return send({}, 503);
            return send(JSON.parse(String(init?.body)).p_payload);
          }
          if (name === 'put_search_cache') return failCache ? send({}, 503) : send(true);
        }
        if (target.hostname === 'workflow-binding.example.com')
          return send({}, failHandoff ? 503 : 200);
        if (target.pathname === '/v1/automation/run-async') {
          starts++;
          if (starts === 1)
            return send({ error: { message: 'output_schema capability not enabled' } }, 403);
          if (starts === 2)
            return send({ error: { message: 'agent_config.max_steps requires beta access' } }, 403);
          return send({ run_id: 'run-1', error: null });
        }
        if (target.pathname.endsWith('/cancel')) return send({ status: 'COMPLETED' });
        if (target.pathname === '/v1/runs/run-1') {
          polls++;
          return send({
            run_id: 'run-1',
            status: polls <= 8 ? 'RUNNING' : 'COMPLETED',
            result: polls <= 8 ? null : { jobs: [job] },
          });
        }
        if (target.hostname === 'api.fetch.tinyfish.ai')
          return send({
            results: [
              {
                url,
                title: 'Engineering Intern at Example',
                text: '# Engineering Intern\n## Job Description\nBuild software.\nLocation: United States\nApply now',
                links: [],
              },
            ],
            errors: [],
          });
        throw new Error('Unexpected outbound request in budget trace');
      });
      vi.stubGlobal('fetch', outbound);
      const db = new Database(env);
      try {
        await db.internal(run.id);
      } catch {
        await db.internal(run.id);
      } // The sole allowed initial read retry.
      const rates = await verifiedRateSnapshot(env, db, { allowRefresh: false });
      const api = new TinyFish({ ...env, ...rates }, db, run.id);
      await db.update(run);
      const ticket = await startGuardedAgent(
        {
          checkpoint: async (_name, callback) => callback(),
          submit: (key, schema, mode) =>
            api.startAgent(url, 'Read one opening', {}, key, schema, mode),
        },
        true,
      );
      const observed = await waitForAgent({
        sleep: async () => {},
        checkpoint: async (_name, callback) => callback(),
        cancellationRequested: async () => Boolean((await db.internal(run.id))?.cancelRequested),
        read: () => api.getRun(ticket.runId),
        cancel: () => api.cancelRun(ticket.runId),
      });
      await db.settle(ticket.operationId, ticket.claimToken, observed.status.toLowerCase(), true);
      await db.update(run);
      const fresh = await api.fetchPage(url, 'verify-one-new-opening');
      run.results = [verifyJob(job, fresh, run.preferences)];
      const startDetails = vi.fn(async () => {
        // Count the createBatch service-binding request in addition to real adapter HTTP calls.
        const created = await fetch('https://workflow-binding.example.com/create-stable-id', {
          method: 'POST',
        });
        if (!created.ok) throw new Error('Handoff response lost');
      });
      expect(await finishOrHandoffSearch(db, run, handoff ? startDetails : undefined)).toBe(
        outcome,
      );
      expect(startDetails).toHaveBeenCalledTimes(handoff ? 1 : 0);
      if (handoff)
        expect(
          outbound.mock.calls.filter(([target]) => String(target).includes('put_search_cache')),
        ).toHaveLength(0);
      expect(outbound).toHaveBeenCalledTimes(expected);
      expect(outbound.mock.calls.length).toBeLessThan(50);
      expect(starts).toBe(3); // Two conclusive pre-execution rejections; exactly one actual execution.
      expect(polls).toBe(9);
      expect(
        outbound.mock.calls.filter(([target]) => String(target).includes('api.fetch.tinyfish.ai')),
      ).toHaveLength(1);
    },
  );
});
