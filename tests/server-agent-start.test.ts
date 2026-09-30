import { describe, expect, it, vi } from 'vitest';
import { startGuardedAgent, type AgentStartIO } from '../server/agent-start';
import { AppError } from '../server/env';

const ticket = {
  runId: 'run-1',
  operationId: 'op-1',
  claimToken: 'claim-1',
  maxSteps: 20 as const,
};
function io(): AgentStartIO {
  return {
    checkpoint: async (_name, callback) => callback(),
    submit: vi.fn().mockResolvedValue(ticket),
  };
}
describe('conclusive Agent capability alternatives', () => {
  it('starts directly through legacy admission when the explicit step-limit flag is disabled', async () => {
    const calls = io();
    await startGuardedAgent(calls, false, false);
    expect(calls.submit).toHaveBeenCalledExactlyOnceWith('portal-agent-legacy', false, 'legacy');
  });
  it('replays an old rejection and raw fallback ticket despite a changed schema toggle without submission', async () => {
    const oldTicket = {
      runId: 'existing-legacy-run',
      operationId: 'old-operation',
      claimToken: 'old-claim',
    };
    const checkpoint = vi
      .fn<AgentStartIO['checkpoint']>()
      .mockResolvedValueOnce({ ticket: null, schemaRejected: true, error: 'Schema unavailable' })
      .mockResolvedValueOnce(oldTicket);
    const submit = vi.fn<AgentStartIO['submit']>();
    const result = await startGuardedAgent({ checkpoint, submit }, false);
    expect(result).toEqual(oldTicket);
    expect(result.maxSteps).toBeUndefined();
    expect(checkpoint.mock.calls.map(([name]) => name)).toEqual([
      'submit-browser-once',
      'submit-without-schema-after-rejection',
    ]);
    expect(submit).not.toHaveBeenCalled();
  });
  it('honors a persisted current-shape schema rejection after a toggle change', async () => {
    const checkpoint = vi
      .fn<AgentStartIO['checkpoint']>()
      .mockResolvedValueOnce({ ticket: null, rejection: 'schema', error: 'Schema unavailable' })
      .mockResolvedValueOnce({ ticket, rejection: null, error: null });
    const submit = vi.fn<AgentStartIO['submit']>();
    expect(await startGuardedAgent({ checkpoint, submit }, false)).toEqual(ticket);
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not retry an unexpected live schema rejection when schema was already omitted', async () => {
    const calls = io();
    vi.mocked(calls.submit).mockRejectedValue(
      new AppError('SCHEMA_ENTITLEMENT', 'Unexpected schema rejection', 403),
    );
    await expect(startGuardedAgent(calls, false)).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
    expect(calls.submit).toHaveBeenCalledOnce();
  });
  it('uses a schema-free goal when explicitly configured without changing the bounded step setting', async () => {
    const calls = io();
    expect(await startGuardedAgent(calls, false)).toBe(ticket);
    expect(calls.submit).toHaveBeenCalledExactlyOnceWith('portal-agent', false, 'bounded');
  });
  it('keeps max_steps when only output_schema is rejected', async () => {
    const calls = io();
    vi.mocked(calls.submit).mockRejectedValueOnce(
      new AppError('SCHEMA_ENTITLEMENT', 'Schema unavailable', 403),
    );
    await startGuardedAgent(calls, true);
    expect(vi.mocked(calls.submit).mock.calls).toEqual([
      ['portal-agent', true, 'bounded'],
      ['portal-agent-without-schema', false, 'bounded'],
    ]);
  });
  it('uses a separately named legacy admission only after conclusive step-limit rejection', async () => {
    const calls = io();
    vi.mocked(calls.submit).mockRejectedValueOnce(
      new AppError('STEP_LIMIT_ENTITLEMENT', 'Bounded setting unavailable', 403),
    );
    await startGuardedAgent(calls, false);
    expect(vi.mocked(calls.submit).mock.calls).toEqual([
      ['portal-agent', false, 'bounded'],
      ['portal-agent-legacy', false, 'legacy'],
    ]);
  });
  it('bounds both distinct capability rejections to two alternatives', async () => {
    const calls = io();
    vi.mocked(calls.submit)
      .mockRejectedValueOnce(new AppError('SCHEMA_ENTITLEMENT', 'Schema unavailable', 403))
      .mockRejectedValueOnce(
        new AppError('STEP_LIMIT_ENTITLEMENT', 'Step setting unavailable', 403),
      );
    await startGuardedAgent(calls, true);
    expect(vi.mocked(calls.submit).mock.calls).toEqual([
      ['portal-agent', true, 'bounded'],
      ['portal-agent-without-schema', false, 'bounded'],
      ['portal-agent-legacy', false, 'legacy'],
    ]);
  });
  it.each(['PROVIDER_ACCESS', 'PROVIDER_TIMEOUT', 'SUBMISSION_UNCERTAIN', 'AGENT_BUDGET_LIMIT'])(
    'never retries or falls back for %s',
    async (code) => {
      const calls = io();
      vi.mocked(calls.submit).mockRejectedValue(new AppError(code, 'Unavailable', 503));
      await expect(startGuardedAgent(calls, true)).rejects.toMatchObject({
        code: 'AGENT_UNAVAILABLE',
      });
      expect(calls.submit).toHaveBeenCalledOnce();
    },
  );
});
