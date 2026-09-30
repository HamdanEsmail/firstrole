import type { ProviderRun } from './tinyfish';

export const AGENT_WAIT_CYCLES = 8;
export const AGENT_HALF_INTERVAL_SECONDS = 30;

export interface AgentObservation {
  status: string;
  resultText: string;
  cancelledByUser: boolean;
  timedOut: boolean;
}

export interface AgentWaitIO {
  sleep(name: string, seconds: number): Promise<void>;
  checkpoint(name: string, callback: () => Promise<AgentObservation>): Promise<AgentObservation>;
  cancellationRequested(): Promise<boolean>;
  read(): Promise<ProviderRun>;
  cancel(): Promise<{ status: string }>;
}

export function isTerminalAgentStatus(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
}

const waiting = (): AgentObservation => ({
  status: 'WAITING',
  resultText: 'null',
  cancelledByUser: false,
  timedOut: false,
});
const observation = (run: ProviderRun): AgentObservation => ({
  status: run.status,
  resultText: JSON.stringify(run.result ?? null),
  cancelledByUser: false,
  timedOut: false,
});

export async function waitForAgent(io: AgentWaitIO): Promise<AgentObservation> {
  const requestedStop = async (): Promise<AgentObservation> => ({
    status: (await io.cancel()).status,
    resultText: 'null',
    cancelledByUser: true,
    timedOut: false,
  });
  for (let i = 0; i < AGENT_WAIT_CYCLES; i++) {
    await io.sleep(`wait-agent-midpoint-${i}`, AGENT_HALF_INTERVAL_SECONDS);
    const midpoint = await io.checkpoint(`check-agent-cancel-${i}`, async () =>
      (await io.cancellationRequested()) ? requestedStop() : waiting(),
    );
    if (midpoint.cancelledByUser) return midpoint;
    await io.sleep(`wait-agent-poll-${i}`, AGENT_HALF_INTERVAL_SECONDS);
    const current = await io.checkpoint(`poll-agent-${i}`, async () => {
      if (await io.cancellationRequested()) return requestedStop();
      try {
        return observation(await io.read());
      } catch {
        return waiting();
      }
    });
    if (current.cancelledByUser || isTerminalAgentStatus(current.status)) return current;
  }
  return io.checkpoint('stop-overdue-agent', async () => {
    const stopped = await io.cancel();
    // Cancellation can race with successful completion. Read the existing run; never submit again.
    if (stopped.status === 'COMPLETED') return observation(await io.read());
    return {
      status: stopped.status,
      resultText: 'null',
      cancelledByUser: false,
      timedOut: stopped.status !== 'FAILED',
    };
  });
}
