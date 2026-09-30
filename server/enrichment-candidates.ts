import type { Job, SearchPreferences } from '../shared/types';
import { safePublicUrl, sha256 } from './http';
import { isJobDetail, listingClosed, scoreJob } from './quality';
import type { FetchedPage } from './tinyfish';

export interface EnrichmentCandidate {
  sourceUrl: string;
  page: { url: string; final_url: string; title: string | null; text: string; links: string[] };
  job: Job | null;
  kind: 'extract' | 'render';
  observedAt: string;
}
export interface EnrichmentInput {
  searchId: string;
  candidates: EnrichmentCandidate[];
}
export interface AgentInput {
  searchId: string;
  sourceUrl: string;
  candidates?: EnrichmentCandidate[];
}

const BLOCKED =
  /sign in to continue|log in to (?:view|continue)|access denied|verify you are human|captcha|404|page not found/i;

/** Only already observed detail pages enter the optional readers. Portals stay with TinyFish. */
export function enrichmentCandidate(
  page: FetchedPage,
  job: Job | null,
): EnrichmentCandidate | null {
  const sourceUrl = safePublicUrl(page.final_url || page.url);
  const text = typeof page.text === 'string' ? page.text.slice(0, 12_000) : '';
  if (
    !sourceUrl ||
    !isJobDetail(sourceUrl) ||
    listingClosed(text) ||
    BLOCKED.test(text.slice(0, 1200))
  )
    return null;
  const incomplete =
    !job ||
    !job.description ||
    job.requirements.length === 0 ||
    job.location === 'Location not stated' ||
    /world(?:'s|’s) (?:leading|trusted)|change the world|company description/i.test(
      job.description,
    ) ||
    (/^[a-z0-9_-]{12,}$/.test(job.company) &&
      !job.evidence.some((item) => item.field === 'company'));
  if (!incomplete) return null;
  return {
    sourceUrl,
    page: {
      url: sourceUrl,
      final_url: sourceUrl,
      title: page.title?.slice(0, 250) || null,
      text,
      links: (page.links || [])
        .flatMap((link) => {
          const safe = safePublicUrl(link);
          return safe ? [safe] : [];
        })
        .slice(0, 40),
    },
    job,
    kind: text.trim().length < 600 ? 'render' : 'extract',
    observedAt: job?.checkedAt || new Date().toISOString(),
  };
}

export function selectEnrichmentCandidates(
  candidates: EnrichmentCandidate[],
): EnrichmentCandidate[] {
  const unique = new Map<string, EnrichmentCandidate>();
  for (const candidate of candidates)
    if (!unique.has(candidate.sourceUrl)) unique.set(candidate.sourceUrl, candidate);
  // Improve an already identified opening before spending on an uncertain source.
  const selected: EnrichmentCandidate[] = [];
  for (const candidate of [...unique.values()].sort((a, b) => Number(Boolean(b.job)) - Number(Boolean(a.job)))) {
    // Workflow parameters have a byte limit. Long links and multi-byte source text count too.
    if (new TextEncoder().encode(JSON.stringify([...selected, candidate])).byteLength > 96 * 1024) continue;
    selected.push(candidate);
    if (selected.length === 2) break;
  }
  return selected;
}

/** This draft is never public until source-backed title AND employer have been extracted. */
export async function observedDraft(
  page: FetchedPage,
  preferences: SearchPreferences,
): Promise<Job | null> {
  const sourceUrl = safePublicUrl(page.final_url || page.url);
  if (
    !sourceUrl ||
    !isJobDetail(sourceUrl) ||
    typeof page.text !== 'string' ||
    page.text.length < 100
  )
    return null;
  if (BLOCKED.test(page.title || '') || BLOCKED.test(page.text.slice(0, 1200))) return null;
  const job: Job = {
    id: await sha256(sourceUrl),
    title: 'Job details',
    company: 'Company not stated',
    location: 'Location not stated',
    workplace: 'unknown',
    remoteRegion: null,
    employmentType: 'unknown',
    sourceUrl,
    applyUrl: sourceUrl,
    requisitionId: null,
    description: '',
    requirements: [],
    salary: null,
    postedAt: null,
    deadline: null,
    checkedAt: new Date().toISOString(),
    sponsorship: 'not-stated',
    evidence: [],
    availability: 'unverified',
    match: { score: 0, tier: 'Possible match', reasons: [] },
  };
  job.match = scoreJob(job, preferences);
  return job;
}

export function hasObservedIdentity(job: Job): boolean {
  return Boolean(
    job.title &&
    job.company &&
    job.company !== 'Company not stated' &&
    job.evidence.some((item) => item.field === 'title') &&
    job.evidence.some((item) => item.field === 'company'),
  );
}
