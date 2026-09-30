import type { AgentPreview, SearchRun } from '../../shared/types';
import { safeAgentPreviewUrl } from '../../shared/agent-preview';
import { ApiError, getAgentPreview } from './api';

export type PreviewDisplay = AgentPreview | { status: 'checking' | 'offline' };

export function canShowAgentPreview(
  run: SearchRun | null,
  workspaceReady: boolean,
  starting: boolean,
): run is SearchRun {
  return Boolean(workspaceReady && !starting && run && !run.cached && run.status === 'extracting');
}

// The subscription owns only an ephemeral viewing capability. Cancelling it
// invalidates in-flight responses before another search/account can render them.
export function observeAgentPreview(
  searchId: string,
  token: string | null,
  onChange: (preview: PreviewDisplay) => void,
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let failures = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const response = await getAgentPreview(searchId, token);
      if (disposed) return;
      failures = 0;
      const sourceName = response.sourceName?.slice(0, 180);
      if (response.status === 'live') {
        const url = safeAgentPreviewUrl(response.url);
        onChange(url ? { status: 'live', url, sourceName } : { status: 'unavailable', sourceName });
        return;
      }
      if (response.status !== 'waiting') {
        onChange({ status: response.status === 'ended' ? 'ended' : 'unavailable', sourceName });
        return;
      }
      onChange({ status: 'waiting', sourceName });
    } catch (error) {
      if (disposed) return;
      failures += 1;
      if (
        failures >= 3 ||
        (error instanceof ApiError && [401, 403, 404, 410].includes(error.status))
      ) {
        onChange({ status: 'unavailable' });
        return;
      }
    }
    if (disposed) return;
    // Allow the durable workflow's startup window to finish. This remains
    // finite, and never submits or restarts a provider operation.
    if (attempts >= 100) {
      onChange({ status: 'unavailable' });
      return;
    }
    timer = setTimeout(poll, attempts < 4 ? 2000 : 5000);
  };
  onChange({ status: 'checking' });
  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
