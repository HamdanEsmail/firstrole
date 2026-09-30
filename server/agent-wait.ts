import type { ProviderRun } from './tinyfish';

export const AGENT_WAIT_CYCLES = 8;
export const AGENT_HALF_INTERVAL_SECONDS = 30;

export interface AgentObservation {
  status: string;
  resultText: string;
  cancelledByUser: boolean;
  timedOut: boolean;
  observedRunId: string | null;
  numOfSteps: number | null;
}

export interface AgentWaitIO {
  sleep(name: string, seconds: number): Promise<void>;
  checkpoint(name: string, callback: () => Promise<AgentObservation>): Promise<AgentObservation>;
  cancellationRequested(): Promise<boolean>;
  read(): Promise<ProviderRun>;
  cancel(): Promise<{ status: string }>;
  readTerminalUsage?: boolean;
}

export function isTerminalAgentStatus(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
}

const waiting = (): AgentObservation => ({
  status: 'WAITING',
  resultText: 'null',
  cancelledByUser: false,
  timedOut: false,
  observedRunId: null,
  numOfSteps: null,
});
const observation = (run: ProviderRun): AgentObservation => ({
  status: run.status,
  resultText: JSON.stringify(run.result ?? null),
  cancelledByUser: false,
  timedOut: false,
  observedRunId: typeof run.run_id === 'string' ? run.run_id : null,
  numOfSteps:
    typeof run.num_of_steps === 'number' && Number.isFinite(run.num_of_steps)
      ? run.num_of_steps
      : null,
});

export async function waitForAgent(io: AgentWaitIO): Promise<AgentObservation> {
  const stoppedObservation = async (
    status: string,
    cancelledByUser: boolean,
  ): Promise<AgentObservation> => {
    if (io.readTerminalUsage && isTerminalAgentStatus(status)) {
      try {
        const run = await io.read();
        if (isTerminalAgentStatus(run.status))
          return { ...observation(run), resultText: 'null', cancelledByUser };
      } catch {
        /* No reported count means the existing reservation remains held. */
      }
    }
    return { ...waiting(), status, cancelledByUser };
  };
  const requestedStop = async () => stoppedObservation((await io.cancel()).status, true);
  for (let i = 0; i < AGENT_WAIT_CYCLES; i++) {
    await io.sleep(`wait-agent-midpoint-${i}`, AGENT_HALF_INTERVAL_SECONDS);
    const midpoint = await io.checkpoint(`check-agent-cancel-${i}`, async () =>
      (await io.cancellationRequested()) ? requestedStop() : waiting(),
    );
    if (midpoint.cancelledByUser) return midpoint;
    await io.sleep(`wait-agent-poll-${i}`, AGENT_HALF_INTERVAL_SECONDS);
    const current = await io.checkpoint(`poll-agent-${i}`, async () => {
      // The Cancel route stops the known provider run immediately. The midpoint
      // database check is its <=60-second backup; a second DB read here is redundant.
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
      ...(await stoppedObservation(stopped.status, false)),
      timedOut: stopped.status !== 'FAILED',
    };
  });
}
