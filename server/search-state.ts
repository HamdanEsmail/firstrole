import type { Job, SearchRun } from '../shared/types';
import { Database } from './db';
import { deduplicate, eligible, fingerprintInput } from './quality';
import { sha256 } from './http';

export function agentVerificationTargets(produced: Job[], previous: Job[]): Job[] {
  return produced
    .filter(
      (job) =>
        job.availability === 'unverified' &&
        !previous.some((existing) => existing.id === job.id && existing.availability === 'open'),
    )
    .slice(0, 1);
}

export function prepareFinishedRun(run: SearchRun, cancelled: boolean): void {
  run.results = deduplicate(run.results)
    .filter((job) => eligible(job, run.preferences))
    .slice(0, 12);
  if (cancelled) {
    run.status = 'cancelled';
    run.stage = 'Search stopped. Results already found are available.';
  } else if (run.results.length) {
    run.status = run.errors.length ? 'partial' : 'completed';
    run.stage = run.errors.length
      ? 'Search finished with some sources unavailable.'
      : 'Your shortlist is ready.';
  } else if (run.errors.length) {
    run.status = 'failed';
    run.stage =
      'These sources could not produce a verified shortlist. Try a broader role or location.';
  } else {
    run.status = 'completed';
    run.stage = 'No matching openings found. Try broadening your preferences.';
  }
}

export async function cacheFinishedRun(db: Database, run: SearchRun): Promise<void> {
  if (run.results.length && run.status !== 'cancelled') {
    // Result delivery is durable already. A cache outage must not rerun finalization or paid work.
    await db
      .rpc('put_search_cache', {
        p_fingerprint: await sha256(fingerprintInput(run.preferences)),
        p_payload: { results: run.results, sources: run.sources, errors: run.errors },
        p_ttl_seconds: 21600,
      })
      .catch(() => {});
  }
}

export async function finishSearch(db: Database, run: SearchRun): Promise<void> {
  const fresh = await db.internal(run.id);
  if (!fresh) return;
  prepareFinishedRun(run, fresh.cancelRequested);
  const saved = await db.update(run);
  if (saved?.status === 'cancelled') return;
  await cacheFinishedRun(db, run);
}
