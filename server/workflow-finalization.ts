import type { SearchRun } from '../shared/types';
import type { Database } from './db';
import { cacheFinishedRun, prepareFinishedRun } from './search-state';

export type FinalizationOutcome =
  'finished' | 'handed-off' | 'cancelled' | 'gone' | 'storage-unavailable';
const TERMINAL = new Set<SearchRun['status']>(['completed', 'partial', 'failed', 'cancelled']);

/**
 * One cancellation read, at most one optional handoff, then bounded terminal persistence.
 * At most five outbound calls including the handoff binding. Failed handoffs never cache.
 * The caller checkpoints this once OUTSIDE its paid-work catch, so failures cannot re-enter it.
 */
export async function finishOrHandoffSearch(
  db: Database,
  run: SearchRun,
  handoff?: () => Promise<unknown>,
): Promise<FinalizationOutcome> {
  let fresh;
  try {
    fresh = await db.internal(run.id);
  } catch {
    return 'storage-unavailable';
  }
  if (!fresh) return 'gone';
  if (TERMINAL.has(fresh.payload.status))
    return fresh.payload.status === 'cancelled' ? 'cancelled' : 'finished';
  const cancelled = fresh.cancelRequested || run.status === 'cancelled';
  let handoffFailed = false;
  if (handoff && !cancelled) {
    try {
      run.status = 'reading';
      run.stage = 'Checking important details against the original postings.';
      const published = await db.update(run);
      if (!published) return 'gone';
      if (TERMINAL.has(published.status))
        return published.status === 'cancelled' ? 'cancelled' : 'finished';
      await handoff();
      return 'handed-off';
    } catch {
      handoffFailed = true;
      run.errors.push({
        message: 'Additional detail checks could not start. Results already read are preserved.',
      });
    }
  }
  prepareFinishedRun(run, cancelled);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // SQL keeps a concurrent cancellation or previously terminal outcome authoritative.
      const saved = await db.update(run);
      if (!saved) return 'gone';
      if (saved.status === 'cancelled') return 'cancelled';
      if (!handoffFailed) await cacheFinishedRun(db, saved);
      return 'finished';
    } catch {
      if (attempt === 1) return 'storage-unavailable';
    }
  }
  return 'storage-unavailable';
}
