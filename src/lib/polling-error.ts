export interface PollingError {
  scope: string;
  runId: string;
  message: string;
}

export function clearRecoveredPollingError(
  currentError: string | null,
  failure: PollingError | null,
  scope: string,
  runId: string,
): string | null {
  if (failure?.scope === scope && failure.runId === runId && currentError === failure.message)
    return null;
  return currentError;
}
