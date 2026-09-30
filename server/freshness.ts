import type { Job, SearchPreferences, SearchRun } from '../shared/types';
import { MAX_JOB_FACTS, type Database } from './db';
import { eligible, scoreJob } from './quality';

const TERMINAL = new Set<SearchRun['status']>(['completed', 'partial', 'failed', 'cancelled']);

// The catalog contains public source facts. Explicitly select those fields so
// a stored match explanation or unrelated metadata never becomes private state.
function publicFacts(job: Job): Omit<Job, 'match'> {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    workplace: job.workplace,
    remoteRegion: job.remoteRegion,
    employmentType: job.employmentType,
    sourceUrl: job.sourceUrl,
    applyUrl: job.applyUrl,
    requisitionId: job.requisitionId,
    description: job.description,
    requirements: [...job.requirements],
    salary: job.salary
      ? { text: job.salary.text, currency: job.salary.currency, period: job.salary.period }
      : null,
    postedAt: job.postedAt,
    deadline: job.deadline,
    checkedAt: job.checkedAt,
    sponsorship: job.sponsorship,
    evidence: job.evidence.map(({ field, text, sourceUrl }) => ({ field, text, sourceUrl })),
    availability: job.availability,
  };
}

export function applyLatestJobFacts(
  results: readonly Job[],
  latest: readonly Job[],
  preferences: SearchPreferences,
): Job[] {
  const originals = results.slice(0, MAX_JOB_FACTS);
  const allowed = new Set(originals.map((job) => job.id));
  const facts = new Map<string, Job>();
  for (const job of latest) {
    if (!allowed.has(job.id) || !Number.isFinite(Date.parse(job.checkedAt))) continue;
    const previous = facts.get(job.id);
    if (!previous || Date.parse(job.checkedAt) > Date.parse(previous.checkedAt))
      facts.set(job.id, job);
  }
  return originals
    .flatMap((original) => {
      const updated = facts.get(original.id);
      const oldTime = Date.parse(original.checkedAt);
      const chosen =
        updated && (!Number.isFinite(oldTime) || Date.parse(updated.checkedAt) > oldTime)
          ? updated
          : original;
      if (!eligible(chosen, preferences)) return [];
      return [{ ...publicFacts(chosen), match: scoreJob(chosen, preferences) }];
    })
    .sort((a, b) => b.match.score - a.match.score || a.title.localeCompare(b.title));
}

export async function hydrateTerminalSearch(
  run: SearchRun,
  db: Pick<Database, 'latestVerifiedJobs'>,
): Promise<SearchRun> {
  if (!TERMINAL.has(run.status) || !run.results.length) return run;
  const results = run.results.slice(0, MAX_JOB_FACTS);
  const latest = await db.latestVerifiedJobs(results.map((job) => job.id));
  return { ...run, results: applyLatestJobFacts(results, latest, run.preferences) };
}
