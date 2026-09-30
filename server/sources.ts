import type { SearchPreferences } from '../shared/types';
import {
  hasConflictingLocation,
  hasRecognizedLocation,
  isJobDetail,
  locationEligible,
  sourceCandidate,
} from './quality';

const AGGREGATORS = [
  'indeed.com',
  'bayt.com',
  'linkedin.com',
  'glassdoor.com',
  'naukrigulf.com',
  'gulftalent.com',
  'ziprecruiter.com',
  'foundit.com',
  'prosple.com',
  'bebee.com',
];
const ATS = [
  'smartrecruiters.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workable.com',
  'successfactors.com',
  'icims.com',
];
const matchesDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

export interface SearchQuery {
  query: string;
  options: { includeDomains?: string; excludeDomains?: string };
}

export function discoveryQueries(p: SearchPreferences): SearchQuery[] {
  const role = p.role.replace(/["\\]/g, ' ').trim();
  const location = p.location.replace(/["\\]/g, ' ').trim();
  const terms = p.jobTypes.map((type) => (type === 'entry-level' ? '"entry level"' : type));
  const alternativeLocation = /^united arab emirates$/i.test(location)
    ? 'UAE'
    : /^united states$/i.test(location)
      ? 'USA'
      : /^united kingdom$/i.test(location)
        ? 'UK'
        : location;
  return [
    {
      query: `${role} "${location}" ${terms[0]} ${p.keywords}`.trim(),
      options: { excludeDomains: AGGREGATORS.join(',') },
    },
    {
      query: `${role} "${location}" ${terms[1] || terms[0]}`,
      options: { includeDomains: ATS.join(',') },
    },
    {
      query: `${role} ${alternativeLocation} ${terms[2] || terms[0]} jobs ${p.keywords}`.trim(),
      options: { excludeDomains: AGGREGATORS.join(',') },
    },
  ];
}

function priority(url: string): number {
  const host = new URL(url).hostname;
  if (AGGREGATORS.some((domain) => matchesDomain(host, domain))) return 60;
  if (ATS.some((domain) => matchesDomain(host, domain))) return 0;
  return 2;
}

function companyKey(url: string): string {
  const parsed = new URL(url);
  // Several employers share one ATS hostname; count their company paths independently.
  return /smartrecruiters\.com$|greenhouse\.io$|lever\.co$|ashbyhq\.com$|workable\.com$/.test(
    parsed.hostname,
  )
    ? `${parsed.hostname}/${parsed.pathname.split('/').filter(Boolean)[0] || ''}`
    : parsed.hostname;
}

export interface DiscoveryHit {
  url: string;
  title?: string;
  snippet?: string;
}
const EARLY_CAREER =
  /(?:^|[^a-z0-9])(?:intern(?:ship)?s?|graduates?|entry[-_ ]?level|trainees?|apprentices?|juniors?|associates?|early[-_ ]?careers?)(?=$|[^a-z0-9])/i;
const SENIOR_ROLE =
  /\b(?:senior|sr|principal|director|vice president|head of|staff engineer|lead|manager)\b/i;
function normalized(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* Never invent a replacement URL. */
  }
  return decoded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function stems(value: string): string[] {
  return normalized(value)
    .split(' ')
    .filter(
      (word) =>
        word.length > 1 &&
        !['the', 'and', 'for', 'job', 'jobs', 'in', 'of', 'to', 'at', 'an'].includes(word),
    )
    .map((word) =>
      word.length <= 2 ? word : word.replace(/ing$|ments?$|ships?$|s$/g, '').replace(/e$/, ''),
    );
}

export function sourceRelevance(
  hit: DiscoveryHit,
  preferences: SearchPreferences,
): { url: string; score: number; located: boolean; detail: boolean } | null {
  const url = sourceCandidate(hit.url);
  if (!url) return null;
  const parsed = new URL(url);
  if (/\/(?:apply|application)(?:\/|$)/i.test(parsed.pathname)) return null;
  const detail = isJobDetail(url);
  const jobPath = parsed.pathname.split(/\/(?:jobs?|positions?|j)\//i).at(-1) || '';
  const primary = normalized(`${hit.title || ''} ${jobPath}`);
  const snippet = normalized(hit.snippet || '');
  const combined = `${primary} ${snippet}`;
  if (
    detail &&
    SENIOR_ROLE.test(primary) &&
    (!EARLY_CAREER.test(primary) ||
      /\b(?:senior|sr|principal|director|head of|staff engineer|lead)\b/.test(primary))
  )
    return null;
  const requested = stems(preferences.role);
  const primaryWords = stems(primary);
  const combinedWords = stems(combined);
  const matchingStem = (word: string, stem: string) =>
    stem.length <= 2
      ? word === stem
      : word.startsWith(stem) || (word.length > 2 && stem.startsWith(word));
  const primaryMatches = requested.filter((stem) =>
    primaryWords.some((word) => matchingStem(word, stem)),
  ).length;
  const combinedMatches = requested.filter((stem) =>
    combinedWords.some((word) => matchingStem(word, stem)),
  ).length;
  if (!requested.length || combinedMatches < requested.length) return null;
  const matchesLocation = (value: string) =>
    locationEligible(
      { location: value, workplace: 'onsite', remoteRegion: null },
      preferences.location,
    );
  const primaryLocated = matchesLocation(primary);
  const located = primaryLocated || matchesLocation(combined);
  // A clearly different location in the listing's title/path outweighs incidental footer terms.
  if (!primaryLocated && hasConflictingLocation(primary, preferences.location)) return null;
  if (!located && (hasRecognizedLocation(snippet) || !detail)) return null;
  const early = EARLY_CAREER.test(combined);
  if (detail && !early && primaryMatches < requested.length) return null;
  const keywordMatches = stems(preferences.keywords).filter((stem) =>
    combinedWords.some((word) => matchingStem(word, stem)),
  ).length;
  const score =
    (detail ? 35 : 10) +
    Math.round((25 * primaryMatches) / requested.length) +
    (primaryLocated ? 30 : located ? 22 : -25) +
    (early ? 20 : 0) -
    priority(url) +
    Math.min(15, keywordMatches * 5);
  return { url, score, located, detail };
}

export function selectSourceUrls(hits: DiscoveryHit[], preferences: SearchPreferences): string[] {
  const best = new Map<string, NonNullable<ReturnType<typeof sourceRelevance>>>();
  for (const hit of hits) {
    const candidate = sourceRelevance(hit, preferences);
    if (candidate && (!best.has(candidate.url) || candidate.score > best.get(candidate.url)!.score))
      best.set(candidate.url, candidate);
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score);
  const chosen: string[] = [];
  const companies = new Set<string>();
  let unlocated = 0;
  const companyKeywords = stems(preferences.keywords);
  const preferredPortal = candidates.find(
    (candidate) =>
      !candidate.detail &&
      candidate.located &&
      priority(candidate.url) < 60 &&
      companyKeywords.some((keyword) =>
        normalized(new URL(candidate.url).hostname).split(' ').includes(keyword),
      ),
  );
  if (preferredPortal) {
    chosen.push(preferredPortal.url);
    companies.add(companyKey(preferredPortal.url));
  }
  for (const candidate of candidates) {
    if (chosen.length === 4) break;
    if (companies.has(companyKey(candidate.url)) || (!candidate.located && unlocated >= 1))
      continue;
    chosen.push(candidate.url);
    companies.add(companyKey(candidate.url));
    if (!candidate.located) unlocated++;
  }
  for (const candidate of candidates) {
    if (chosen.length === 4) break;
    if (chosen.includes(candidate.url) || (!candidate.located && unlocated >= 1)) continue;
    chosen.push(candidate.url);
    if (!candidate.located) unlocated++;
  }
  return chosen;
}

export interface SourceReading {
  url: string;
  readable: boolean;
  blocked: boolean;
  closed: boolean;
  incomplete: boolean;
}

export function selectAgentSource(
  readings: SourceReading[],
  preferences?: SearchPreferences,
  coveredSources: string[] = [],
): string | undefined {
  const usable = readings.filter(
    (source) =>
      !source.blocked &&
      !source.closed &&
      source.incomplete &&
      priority(source.url) < 60 &&
      !coveredSources.includes(source.url),
  );
  const keywords = stems(preferences?.keywords || '');
  const keywordScore = (url: string) =>
    keywords.filter((keyword) => normalized(new URL(url).hostname).split(' ').includes(keyword))
      .length *
      2 +
    keywords.filter((keyword) => normalized(url).split(' ').includes(keyword)).length;
  usable.sort(
    (a, b) =>
      Number(b.readable) - Number(a.readable) ||
      keywordScore(b.url) - keywordScore(a.url) ||
      priority(a.url) - priority(b.url) ||
      Number(isJobDetail(a.url)) - Number(isJobDetail(b.url)),
  );
  return usable[0]?.url;
}

export function observedJobLinks(
  page: { url: string; final_url?: string; text?: unknown; links?: string[] },
  preferences: SearchPreferences,
  alreadyRead: string[],
): string[] {
  const observed = new Map<string, string>();
  for (const url of (page.links || []).slice(0, 200)) {
    const safe = sourceCandidate(url);
    if (safe) observed.set(safe, '');
  }
  if (typeof page.text === 'string') {
    for (const match of page.text
      .slice(0, 60_000)
      .matchAll(/\[([^\]]{1,250})\]\((https:\/\/[^\s)]+)\)/g)) {
      const safe = sourceCandidate(match[2]);
      if (safe) observed.set(safe, match[1]);
    }
  }
  const stems =
    preferences.role
      .toLowerCase()
      .match(/[a-z]{3,}/g)
      ?.map((word) => word.replace(/ing$|ment$|ships?$|s$/g, '')) || [];
  return [...observed]
    .filter(([url, label]) => {
      if (!isJobDetail(url) || alreadyRead.includes(url)) return false;
      if (/\/(?:apply|application)(?:\/|$)/i.test(new URL(url).pathname)) return false;
      let context = `${url} ${label}`.toLowerCase();
      try {
        context = decodeURIComponent(context);
      } catch {
        /* Keep the observed URL unchanged. */
      }
      return (
        sourceRelevance({ url, title: label }, preferences) !== null &&
        /(?:^|[^a-z0-9])(?:intern(?:ship)?s?|graduates?|entry[-_ ]?level|trainees?|apprentices?|juniors?|associates?|early[-_ ]?careers?)(?=$|[^a-z0-9])/.test(
          context,
        ) &&
        stems.some((stem) => context.includes(stem))
      );
    })
    .map(([url]) => url)
    .slice(0, 4);
}

export function selectFollowupUrls(urls: string[], alreadyRead: string[]): string[] {
  const candidates = [...new Set(urls)]
    .filter(
      (url) =>
        !alreadyRead.includes(url) &&
        !/\/(?:apply|application)(?:\/|$)/i.test(new URL(url).pathname),
    )
    .sort((a, b) => priority(a) - priority(b));
  const chosen: string[] = [];
  for (const url of candidates) {
    if (!chosen.some((other) => companyKey(other) === companyKey(url))) chosen.push(url);
    if (chosen.length === 2) break;
  }
  for (const url of candidates) if (chosen.length < 2 && !chosen.includes(url)) chosen.push(url);
  return chosen;
}
