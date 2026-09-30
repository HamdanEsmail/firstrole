import type { AgentPreview, SearchRun } from '../shared/types';
import { safeAgentPreviewUrl } from '../shared/agent-preview';
import type { Database } from './db';
import type { TinyFish } from './tinyfish';

/** Caller must load the run through Database.get(id, actorKey) before calling this helper. */
export async function readAgentPreview(
  run: SearchRun,
  db: Pick<Database, 'operations'>,
  api: Pick<TinyFish, 'getRun'>,
): Promise<AgentPreview> {
  if (run.cached || run.status !== 'extracting') return { status: 'ended' };
  const sourceName = run.sources.find((source) => source.status === 'extracting')?.name;
  const operations = await db.operations(run.id);
  const agent = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.kind === 'agent' &&
        operation.providerRunId &&
        !operation.terminalVerified &&
        operation.state !== 'settled',
    );
  if (!agent) return { status: 'waiting', ...(sourceName ? { sourceName } : {}) };
  try {
    const current = await api.getRun(agent.providerRunId!);
    if (current.run_id !== agent.providerRunId) return { status: 'unavailable' };
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) return { status: 'ended' };
    if (!['PENDING', 'RUNNING'].includes(current.status)) return { status: 'unavailable' };
    const url = safeAgentPreviewUrl(current.streaming_url);
    if (url) return { status: 'live', url, ...(sourceName ? { sourceName } : {}) };
    return {
      status: current.streaming_url ? 'unavailable' : 'waiting',
      ...(sourceName ? { sourceName } : {}),
    };
  } catch {
    // The UI has a finite retry policy. Never return provider payloads or tokenized URLs in errors.
    return { status: 'waiting', ...(sourceName ? { sourceName } : {}) };
  }
}
