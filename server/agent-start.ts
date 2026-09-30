import { AppError } from './env';
import { safeMessage } from './http';
import type { AgentTicket } from './tinyfish';

export interface AgentStartAttempt {
  ticket: AgentTicket | null;
  rejection?: 'schema' | 'steps' | null;
  error: string | null;
  /** Compatibility with an earlier persisted schema-rejection checkpoint. */
  schemaRejected?: boolean;
}
export interface AgentStartIO {
  checkpoint(
    name: string,
    callback: () => Promise<AgentStartAttempt>,
  ): Promise<AgentStartAttempt | AgentTicket>;
  submit(key: string, useSchema: boolean, mode: 'bounded' | 'legacy'): Promise<AgentTicket>;
}

function savedTicket(value: AgentStartAttempt | AgentTicket): AgentTicket | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = 'ticket' in value ? value.ticket : value;
  if (
    !candidate ||
    typeof candidate.runId !== 'string' ||
    !/^[a-z\d_-]{1,256}$/i.test(candidate.runId) ||
    typeof candidate.operationId !== 'string' ||
    !candidate.operationId ||
    typeof candidate.claimToken !== 'string' ||
    !candidate.claimToken
  )
    return null;
  // Missing caps in historical raw tickets remain unknown; never infer one for accounting.
  return candidate;
}

/** Only confirmed pre-execution capability rejections can start a separately reserved alternative. */
export async function startGuardedAgent(
  io: AgentStartIO,
  useSchema: boolean,
  useStepLimit = true,
): Promise<AgentTicket> {
  let mode: 'bounded' | 'legacy' = useStepLimit ? 'bounded' : 'legacy';
  let schema = useSchema;
  let schemaFallback = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = schemaFallback
      ? 'portal-agent-without-schema'
      : mode === 'legacy'
        ? 'portal-agent-legacy'
        : attempt === 0
          ? 'portal-agent'
          : 'portal-agent-without-schema';
    const name =
      attempt === 0
        ? 'submit-browser-once'
        : schemaFallback
          ? 'submit-without-schema-after-rejection'
          : mode === 'legacy'
            ? 'submit-legacy-after-step-rejection'
            : 'submit-without-schema-after-rejection';
    let executed = false;
    const result = await io.checkpoint(name, async () => {
      executed = true;
      try {
        return { ticket: await io.submit(key, schema, mode), rejection: null, error: null };
      } catch (error) {
        return {
          ticket: null,
          rejection:
            error instanceof AppError && error.code === 'SCHEMA_ENTITLEMENT'
              ? 'schema'
              : error instanceof AppError && error.code === 'STEP_LIMIT_ENTITLEMENT'
                ? 'steps'
                : null,
          error: safeMessage(error),
        };
      }
    });
    const ticket = savedTicket(result);
    if (ticket) return ticket;
    const outcome = result as AgentStartAttempt;
    if (outcome.rejection === 'steps' && (mode === 'bounded' || !executed)) {
      // startAgent settled the rejected bounded operation at zero. Its legacy mode
      // must reserve the original $2.50 before it can omit the unsupported limit.
      mode = 'legacy';
      schema = false;
      schemaFallback = false;
    } else if (
      (outcome.rejection === 'schema' || outcome.schemaRejected) &&
      (schema || !executed)
    ) {
      schema = false;
      schemaFallback = true;
    } else
      throw new AppError(
        'AGENT_UNAVAILABLE',
        outcome.error || 'This career portal could not be checked.',
        502,
      );
  }
  throw new AppError(
    'AGENT_UNAVAILABLE',
    'This account could not start the browser-assisted check. Results already found are preserved.',
    502,
  );
}
