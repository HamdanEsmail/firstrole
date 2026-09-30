import type { Job, SearchPreferences } from '../shared/types';
import { AppError } from './env';
import { safePublicUrl, sha256 } from './http';
import {
  confirmedDescription,
  extractCompensation,
  extractRoleContent,
  mergeConfirmedRequirements,
  plainText,
  sourceCompanyCase,
  sourceConfirmsClaim,
} from './content';

const text = (value: unknown, max = 300): string =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const words = (value: string): string[] =>
  value
    .toLowerCase()
    .match(/[\p{L}\p{N}+#.]{2,}/gu)
    ?.map((word) => word.replace(/\.+$/, ''))
    ?.filter(
      (w) =>
        w.length > 1 &&
        !['the', 'and', 'for', 'with', 'job', 'jobs', 'role', 'in', 'of'].includes(w),
    ) ?? [];
const CLOSED =
  /(?:this (?:job|position|vacancy|opening) (?:is|has been) (?:now )?(?:closed|filled|removed)|\b(?:job|position|vacancy|opening)\b[^.!?\n]{0,100}\bhas been (?:filled|closed|removed)\b|no longer (?:accepting applications|available)|job (?:has )?expired|position has been filled|\bthe page you (?:are|were) looking for (?:does not|doesn['’]t) exist\b|\b(?:page|job) (?:was )?not found\b)/i;
const SENIOR =
  /\b(senior|sr\.?|principal|director|head of|vice president|staff engineer|lead engineer)\b/i;

export function listingClosed(value: unknown): boolean {
  return typeof value === 'string' && CLOSED.test(value.slice(0, 60_000));
}

export function deadlinePassed(deadline: string | null, now = Date.now()): boolean {
  if (!deadline) return false;
  const timestamp = Date.parse(deadline);
  if (!Number.isFinite(timestamp)) return false;
  // Source dates generally omit a closing hour/timezone. Treat the stated day as inclusive.
  return new Date(timestamp).toISOString().slice(0, 10) < new Date(now).toISOString().slice(0, 10);
}

function sponsorshipFromText(value: string): Job['sponsorship'] {
  const content = value
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (abbreviation) => abbreviation.replaceAll('.', ''))
    .replace(/\s+/g, ' ');
  if (
    /\b(no|not|without|unable|cannot)\b[^.!?]{0,100}\bsponsor(?:ship)?\b|\bsponsor(?:ship)?\b[^.!?]{0,140}\b(?:not (?:available|provided|offered)|unavailable|cannot be|will not)\b/i.test(
      content,
    )
  )
    return 'unavailable';
  if (
    /\bsponsor(?:ship)?\b[^.!?]{0,80}\b(?:available|provided|offered)\b|\b(?:provide|offer)\b[^.!?]{0,60}\bsponsor(?:ship)?\b/i.test(
      content,
    )
  )
    return 'available';
  return 'not-stated';
}

const COUNTRY_AREAS: Record<string, string[]> = {
  ae: [
    'uae',
    'united arab emirates',
    'dubai',
    'abu dhabi',
    'sharjah',
    'ajman',
    'al ain',
    'fujairah',
    'ras al khaimah',
    'umm al quwain',
  ],
  sa: ['saudi arabia', 'ksa', 'riyadh', 'jeddah', 'dammam', 'dhahran'],
  qa: ['qatar', 'doha'],
  kw: ['kuwait'],
  bh: ['bahrain', 'manama'],
  om: ['oman', 'muscat'],
  us: [
    'united states',
    'usa',
    'us',
    'new york',
    'boston',
    'seattle',
    'san francisco',
    'austin',
    'chicago',
    'los angeles',
  ],
  gb: [
    'united kingdom',
    'uk',
    'great britain',
    'england',
    'scotland',
    'wales',
    'london',
    'manchester',
    'edinburgh',
  ],
  ca: ['canada', 'toronto', 'vancouver', 'montreal', 'ottawa'],
  de: ['germany', 'berlin', 'munich', 'frankfurt', 'hamburg'],
  fr: ['france', 'paris', 'lyon'],
  in: ['india', 'bengaluru', 'bangalore', 'hyderabad', 'mumbai', 'delhi', 'pune', 'chennai'],
  au: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth'],
};
const COUNTRY_NAMES: Record<string, string[]> = {
  ae: ['uae', 'united arab emirates'],
  sa: ['saudi arabia', 'ksa'],
  qa: ['qatar'],
  kw: ['kuwait'],
  bh: ['bahrain'],
  om: ['oman'],
  us: ['us', 'usa', 'united states'],
  gb: ['uk', 'united kingdom', 'great britain'],
  ca: ['canada'],
  de: ['germany'],
  fr: ['france'],
  in: ['india'],
  au: ['australia'],
};
const placeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}/g, (abbreviation) => abbreviation.replaceAll('.', ''))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const hasPlace = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);

export function hasRecognizedLocation(value: string): boolean {
  const normalized = placeText(value);
  return Object.values(COUNTRY_AREAS).some((aliases) =>
    aliases.some((alias) => alias.length > 2 && hasPlace(normalized, alias)),
  );
}

export function hasConflictingLocation(value: string, requested: string): boolean {
  if (
    !hasRecognizedLocation(value) ||
    locationEligible({ location: value, workplace: 'onsite', remoteRegion: null }, requested)
  )
    return false;
  const source = placeText(value);
  const wanted = placeText(requested);
  const country = Object.entries(COUNTRY_AREAS).find(([, aliases]) =>
    aliases.some((alias) => hasPlace(wanted, alias)),
  )?.[0];
  if (country && COUNTRY_NAMES[country].some((alias) => hasPlace(source, alias))) {
    const specificPlace = Object.entries(COUNTRY_AREAS).some(([code, aliases]) =>
      aliases.some((alias) => !COUNTRY_NAMES[code].includes(alias) && hasPlace(source, alias)),
    );
    if (!specificPlace) return false;
  }
  return true;
}

export function locationEligible(
  job: Pick<Job, 'location' | 'workplace' | 'remoteRegion'>,
  requested: string,
): boolean {
  const wanted = placeText(requested);
  const location = placeText(job.location);
  const region = placeText(job.remoteRegion || '');
  if (!wanted || (/^(location not stated|unknown|not stated)$/.test(location) && !region))
    return false;
  if (/^(anywhere|worldwide|global|any location)$/.test(wanted)) return true;
  if (wanted === 'remote') return job.workplace === 'remote';
  const requestedCountry = Object.entries(COUNTRY_AREAS).find(([, aliases]) =>
    aliases.some((alias) => hasPlace(wanted, alias)),
  )?.[0];
  const isCountryRequest =
    requestedCountry && COUNTRY_NAMES[requestedCountry].some((alias) => wanted === alias);
  const source = job.workplace === 'remote' ? `${location} ${region}` : location;
  // Explicit remote eligibility is required; 'remote' by itself never means worldwide.
  if (job.workplace === 'remote') {
    if (
      /\b(worldwide|global|anywhere|all countries)\b/.test(region) &&
      !/\b(except|excluding|not available|only)\b/.test(region)
    )
      return true;
    if (
      requestedCountry &&
      COUNTRY_NAMES[requestedCountry].some((alias) => hasPlace(region, alias))
    )
      return true;
    if (
      requestedCountry &&
      ['ae', 'sa', 'qa', 'kw', 'bh', 'om'].includes(requestedCountry) &&
      /\b(gcc|gulf cooperation council|middle east|emea)\b/.test(region)
    )
      return true;
    if (
      requestedCountry &&
      ['de', 'fr', 'gb'].includes(requestedCountry) &&
      /\b(europe|emea)\b/.test(region)
    )
      return true;
  }
  if (isCountryRequest)
    return COUNTRY_AREAS[requestedCountry].some((alias) => hasPlace(source, alias));
  // For a city plus country input, matching just the country would falsely admit a different city.
  let locality = wanted;
  if (requestedCountry)
    for (const alias of COUNTRY_NAMES[requestedCountry])
      locality = ` ${locality} `.replace(` ${alias} `, ' ').trim();
  return Boolean(locality && hasPlace(source, locality));
}

export function validatePreferences(input: unknown): SearchPreferences {
  if (!input || typeof input !== 'object')
    throw new AppError('INVALID_PREFERENCES', 'Add a role and location to start your search.');
  const p = input as Record<string, unknown>;
  const role = text(p.role, 100);
  const location = text(p.location, 100);
  if (role.length < 2 || location.length < 2)
    throw new AppError(
      'INVALID_PREFERENCES',
      'Enter a role and a location, such as Data analyst and Dubai.',
    );
  const jobTypes = Array.isArray(p.jobTypes)
    ? [...new Set(p.jobTypes)].filter((x): x is SearchPreferences['jobTypes'][number] =>
        ['internship', 'graduate', 'entry-level'].includes(String(x)),
      )
    : [];
  const workplaces = Array.isArray(p.workplaces)
    ? [...new Set(p.workplaces)].filter((x): x is SearchPreferences['workplaces'][number] =>
        ['remote', 'hybrid', 'onsite'].includes(String(x)),
      )
    : [];
  if (!jobTypes.length)
    throw new AppError('INVALID_PREFERENCES', 'Choose at least one opportunity type.');
  const days = p.postedWithinDays;
  if (days !== null && days !== undefined && ![7, 14, 30, 60, 90].includes(Number(days)))
    throw new AppError('INVALID_PREFERENCES', 'Choose a supported posting date filter.');
  return {
    role,
    location,
    jobTypes,
    workplaces,
    keywords: text(p.keywords, 200),
    sponsorshipRequired: p.sponsorshipRequired === true,
    postedWithinDays: days == null ? null : Number(days),
  };
}

export function sourceCandidate(value: unknown): string | null {
  const url = safePublicUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  if (
    /(?:^|\.)google\.com$/.test(parsed.hostname) &&
    /\/jobs\/results\/jobs\/results\//i.test(parsed.pathname)
  )
    return null;
  if (/\.(pdf|docx?|xlsx?|zip)$/i.test(parsed.pathname)) return null;
  if (
    /(?:^|\.)(youtube\.com|facebook\.com|instagram\.com|reddit\.com|pinterest\.com|tiktok\.com)$/.test(
      parsed.hostname,
    )
  )
    return null;
  if (/\/(blog|news|article|advice|salary|salaries|login|signin)(\/|$)/i.test(parsed.pathname))
    return null;
  return /career|jobs?|vacanc|greenhouse|lever\.co|ashbyhq|workable|myworkdayjobs|smartrecruiters|successfactors|taleo|icims|bamboohr/i.test(
    parsed.hostname + parsed.pathname,
  )
    ? url
    : null;
}

export function isJobDetail(url: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname;
  return (
    /\/(?:jobs?|positions?|requisitions?)\/[^/?]+/i.test(path) ||
    /[a-f\d]{8}-[a-f\d-]{15,}/i.test(path) ||
    /\/[a-f\d]{24,}\/job\/?$/i.test(path) ||
    /\/(?:j|job-detail|job-details)\/[^/?]+/i.test(path) ||
    (/(?:^|\.)smartrecruiters\.com$/.test(parsed.hostname) &&
      /^\/[^/]+\/\d{8,}-[^/]+\/?$/.test(path))
  );
}

function evidenceDate(value: unknown, evidenceText: string): string | null {
  const date = text(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) || !Number.isFinite(Date.parse(date))) return null;
  // Dates must appear in the source text in ISO or unambiguous English month form.
  const d = new Date(date);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const shortMonth = month.slice(0, 3);
  if (
    !evidenceText.includes(date.slice(0, 10)) &&
    !new RegExp(
      `(?:${month}|${shortMonth})\\s+${d.getUTCDate()}(?:st|nd|rd|th)?,?\\s+${d.getUTCFullYear()}|${d.getUTCDate()}\\s+(?:${month}|${shortMonth})\\s+${d.getUTCFullYear()}`,
      'i',
    ).test(evidenceText)
  )
    return null;
  return date.slice(0, 10);
}

export function scoreJob(job: Job, p: SearchPreferences): Job['match'] {
  let score = 0;
  const reasons: string[] = [];
  const titleWords = words(job.title);
  const roleWords = words(p.role);
  const matched = roleWords.filter((w) => titleWords.some((t) => t === w || t.startsWith(w)));
  if (matched.length) {
    score += Math.round((40 * matched.length) / Math.max(1, roleWords.length));
    reasons.push(`Title includes ${matched.slice(0, 3).join(', ')}`);
  }
  const locationMatches = locationEligible(job, p.location);
  if (locationMatches) {
    score += 25;
    reasons.push(
      job.workplace === 'remote'
        ? `Remote eligibility includes ${p.location}`
        : `Location matches ${p.location}`,
    );
  } else if (job.workplace === 'remote') {
    score += 5;
    reasons.push(
      job.remoteRegion
        ? `Remote eligibility: ${job.remoteRegion}`
        : 'Remote eligibility needs checking',
    );
  }
  if (p.jobTypes.includes(job.employmentType as SearchPreferences['jobTypes'][number])) {
    score += 15;
    reasons.push(
      `${job.employmentType === 'entry-level' ? 'Entry-level' : job.employmentType === 'graduate' ? 'Graduate' : 'Internship'} opportunity`,
    );
  }
  if (
    !p.workplaces.length ||
    p.workplaces.includes(job.workplace as SearchPreferences['workplaces'][number])
  )
    score += 10;
  const keywordMatches = words(p.keywords).filter((w) =>
    words(`${job.title} ${job.company} ${job.description} ${job.requirements.join(' ')}`).includes(
      w,
    ),
  );
  if (keywordMatches.length) {
    score += 10;
    reasons.push(`Mentions ${keywordMatches.slice(0, 3).join(', ')}`);
  }
  if (p.sponsorshipRequired) {
    if (job.sponsorship === 'available') reasons.push('Sponsorship explicitly mentioned');
    else {
      score = Math.min(score, 54);
      reasons.push('Sponsorship eligibility needs checking');
    }
  }
  if (job.availability !== 'open') {
    score = Math.min(score, 54);
    reasons.push('Opening status needs checking');
  }
  if (p.postedWithinDays && !job.postedAt) {
    score = Math.min(score, 54);
    reasons.push('Posting date not stated');
  }
  if (!locationMatches && job.workplace !== 'remote') {
    score = Math.min(score, 54);
    reasons.push(
      job.location === 'Location not stated'
        ? 'Location needs checking'
        : `Listing location: ${job.location}`,
    );
  }
  if (job.workplace === 'remote' && !job.remoteRegion) score = Math.min(score, 54);
  if (p.workplaces.length && job.workplace === 'unknown') {
    score = Math.min(score, 54);
    reasons.push('Work arrangement not stated');
  }
  if (!reasons.length) reasons.push('Review the original listing for fit');
  return {
    score,
    tier: score >= 75 ? 'Strong match' : score >= 55 ? 'Good match' : 'Possible match',
    reasons: reasons.slice(0, 5),
  };
}

export function eligible(job: Job, p: SearchPreferences): boolean {
  if (job.availability === 'closed' || deadlinePassed(job.deadline) || SENIOR.test(job.title))
    return false;
  if (p.sponsorshipRequired && job.sponsorship !== 'available') return false;
  if (job.employmentType === 'unknown' || !p.jobTypes.includes(job.employmentType)) return false;
  if (p.workplaces.length && (job.workplace === 'unknown' || !p.workplaces.includes(job.workplace)))
    return false;
  if (
    p.postedWithinDays &&
    (!job.postedAt ||
      !Number.isFinite(Date.parse(job.postedAt)) ||
      Date.parse(job.postedAt) > Date.now() ||
      Date.now() - Date.parse(job.postedAt) > p.postedWithinDays * 86_400_000)
  )
    return false;
  if (!locationEligible(job, p.location)) return false;
  // A weak title overlap is still surfaced as possible, never as an invented strong fit.
  return true;
}

export async function normalizeAgentJob(
  raw: unknown,
  pageUrl: string,
  p: SearchPreferences,
): Promise<Job | null> {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sourceUrl = sourceCandidate(r.sourceUrl);
  const applyUrl = safePublicUrl(r.applyUrl);
  const title = text(r.title, 200);
  const company = text(r.company, 160);
  if (!sourceUrl || !applyUrl || !title || !company || !isJobDetail(sourceUrl)) return null;
  const allowedEvidence = new Set([sourceUrl, pageUrl, applyUrl]);
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.slice(0, 12).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const e = item as Record<string, unknown>;
        const url = safePublicUrl(e.sourceUrl);
        return url && allowedEvidence.has(url) && text(e.text, 700)
          ? [{ field: text(e.field, 40), text: text(e.text, 700), sourceUrl: url }]
          : [];
      })
    : [];
  if (!evidence.length) return null;
  const description = text(r.description, 4000);
  const sourceText = evidence.map((e) => e.text).join('\n');
  const location = text(r.location, 160) || 'Location not stated';
  const workplace = ['remote', 'hybrid', 'onsite'].includes(String(r.workplace))
    ? (r.workplace as Job['workplace'])
    : 'unknown';
  const employmentType = ['internship', 'graduate', 'entry-level'].includes(
    String(r.employmentType),
  )
    ? (r.employmentType as Job['employmentType'])
    : 'unknown';
  let sponsorship: Job['sponsorship'] = 'not-stated';
  if (evidence.some((e) => e.field === 'sponsorship')) {
    sponsorship = sponsorshipFromText(sourceText);
  }
  const salaryRaw =
    r.salary && typeof r.salary === 'object' ? (r.salary as Record<string, unknown>) : null;
  const salaryText = text(salaryRaw?.text, 200);
  const salaryEvidence = evidence
    .filter((e) => /salary|compensation|pay/i.test(e.field))
    .map((e) =>
      /\b(?:compensation|salary|pay range)\s*:/i.test(e.text) ? e.text : `Compensation: ${e.text}`,
    )
    .join('\n');
  const evidencedPay = extractCompensation(salaryEvidence || sourceText);
  const job: Job = {
    id: await sha256(sourceUrl),
    title,
    company,
    location,
    workplace,
    remoteRegion: workplace === 'remote' ? text(r.remoteRegion, 180) || null : null,
    employmentType,
    sourceUrl,
    applyUrl,
    requisitionId: text(r.requisitionId, 120) || null,
    description,
    requirements: Array.isArray(r.requirements)
      ? r.requirements
          .map((x) => text(x, 350))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    salary: evidencedPay
      ? { text: evidencedPay.text, currency: evidencedPay.currency, period: evidencedPay.period }
      : salaryRaw &&
          salaryText &&
          /salary|compensation|pay/i.test(sourceText) &&
          sourceConfirmsClaim(salaryText, sourceText)
        ? {
            text: salaryText,
            currency: text(salaryRaw.currency, 12) || null,
            period: text(salaryRaw.period, 20) || null,
          }
        : null,
    postedAt: evidenceDate(r.postedAt, sourceText),
    deadline: evidenceDate(r.deadline, sourceText),
    checkedAt: new Date().toISOString(),
    sponsorship,
    evidence,
    availability: CLOSED.test(sourceText) ? 'closed' : 'unverified',
    match: { score: 0, tier: 'Possible match', reasons: [] },
  };
  job.match = scoreJob(job, p);
  return job;
}

function postingLabel(visible: string, labels: string): string | null {
  const related = visible.search(
    /(?:^|\n)\s*(?:related|similar|recommended|other) (?:jobs?|roles?|openings?)\b[^\n]*\n/i,
  );
  if (related >= 0) visible = visible.slice(0, related);
  const value = visible.match(
    new RegExp(`(?:^|\\n|[ \\t])(?:${labels})\\s*[:：]\\s*([^\\n]+)`, 'i'),
  )?.[1];
  // Some readers flatten adjacent metadata fields onto one line. Stop at the next named field.
  return (
    value
      ?.split(
        /\s+(?:(?:State\/Province|Business Group|Legal Entity|Business Line|Work Location Model|Operating Group|Primary Location|Compensation)\s*:|Company Description\b)/i,
      )[0]
      ?.trim() || null
  );
}

function postingLocation(visible: string): string | null {
  return (
    postingLabel(visible, 'Primary (?:Job )?Location') ||
    postingLabel(visible, 'Job Location|Locations?') ||
    visible.match(/(?:^|\n)Locations?\s*\n\s*([^\n]+)/i)?.[1]?.trim() ||
    null
  );
}

function postingWorkplace(
  visible: string,
): { workplace: Job['workplace']; evidence: string } | null {
  const value = postingLabel(
    visible,
    'Work Location Model|Workplace|Work Model|Working Arrangement',
  );
  if (!value || /\b(?:no|not|non)[ -]?(?:remote|hybrid|on[- ]?site)\b/i.test(value)) return null;
  const workplace = /\bhybrid\b/i.test(value)
    ? 'hybrid'
    : /\bremote\b/i.test(value)
      ? 'remote'
      : /\b(?:on[- ]?site|in[- ]office)\b/i.test(value)
        ? 'onsite'
        : 'unknown';
  return workplace === 'unknown' ? null : { workplace, evidence: value };
}

function employerFromSource(
  content: string,
  metadataTitle: string,
  roleTitle: string,
  url: string,
): string | null {
  const host = new URL(url).hostname;
  const visible = plainText(content);
  const legalEntity = postingLabel(visible, 'Legal Entity|Employing Entity');
  const companyHeading = content.match(
    /^###\s+(.+?)\s*[-–—|]\s*(?:Students|Careers|Jobs|Early Careers)\s*$/im,
  )?.[1];
  const describedCompany = content
    .match(/^#{1,6}\s+Company Description\s*\n+([\p{L}\p{N}&.'’ -]{2,70}?)\s+(?:is|are)\b/imu)?.[1]
    ?.trim();
  const suffix = metadataTitle.match(/\s+(?:\||–|—)\s+([^|]+?)(?:\s+Careers)?$/i)?.[1]?.trim();
  const invalidSuffix =
    suffix &&
    /^(?:spring|summer|autumn|fall|winter|class of|cohort|20\d{2}|remote|hybrid|full[- ]time|part[- ]time|careers?|jobs?)\b|smartrecruiters|workday|greenhouse|lever|ashby/i.test(
      suffix,
    );
  return (
    postingLabel(visible, 'Company|Employer|Hiring organization') ||
    roleTitle.match(/\s+at\s+(.+)$/i)?.[1] ||
    metadataTitle.match(/\s+at\s+(.+)$/i)?.[1] ||
    companyHeading ||
    (describedCompany && !/^(?:we|our|the company|this company)\b/i.test(describedCompany)
      ? describedCompany
      : null) ||
    legalEntity ||
    (/myworkdayjobs\.com$/.test(host) ? host.split('.')[0] : null) ||
    (suffix && !invalidSuffix ? suffix : null) ||
    (/lever\.co$|greenhouse\.io$|ashbyhq\.com$|smartrecruiters\.com$/.test(host)
      ? new URL(url).pathname.split('/').filter(Boolean)[0]
      : null) ||
    null
  );
}

function cleanRoleTitle(value: string, company: string): string {
  let result = value.replace(/^(job application for|apply for)\s+/i, '').trim();
  const at = result.match(/^(.*?)\s+at\s+(.+)$/i);
  if (at && at[2].toLowerCase() === company.toLowerCase()) result = at[1];
  const suffix = result.match(/^(.*?)\s+(?:\||–|—|-)\s+(.+)$/);
  if (
    suffix &&
    (suffix[2].toLowerCase() === company.toLowerCase() ||
      /^(?:smartrecruiters|workday|greenhouse|careers)$/i.test(suffix[2]))
  )
    result = suffix[1];
  return result.trim();
}

export async function extractPageJob(
  page: {
    url: string;
    final_url?: string;
    title?: string | null;
    text?: unknown;
    links?: string[];
  },
  p: SearchPreferences,
): Promise<Job | null> {
  const url = sourceCandidate(page.final_url || page.url);
  if (!url || !isJobDetail(url) || typeof page.text !== 'string') return null;
  const content = page.text.slice(0, 60_000);
  const visible = plainText(content);
  const roleContent = extractRoleContent(content);
  const compensation = extractCompensation(content);
  const headings = [...content.matchAll(/^#{1,2}\s+([^\n]+)/gm)]
    .map((match) => match[1])
    .filter(
      (value) =>
        !/^(careers?|welcome|job (?:search|details|description)|search results|locations?|time type|posted on)\b/i.test(
          value,
        ),
    );
  const metadataRole = (page.title || '').replace(/\s+at\s+.+$/i, '').split(/\s+(?:\||–|—)\s+/)[0];
  const metadataWords = words(metadataRole);
  const heading =
    headings.find(
      (value) =>
        metadataWords.length >= 2 &&
        metadataWords.filter((word) => words(value).includes(word)).length >=
          Math.ceil(metadataWords.length * 0.7),
    ) || headings[0];
  const pageTitle = text(heading || page.title, 250);
  if (
    !pageTitle ||
    (!heading && /(?:^|\s)careers?$/i.test(pageTitle)) ||
    /^(careers?|job search|jobs|search results|access denied|sign in)/i.test(pageTitle)
  )
    return null;
  const company = employerFromSource(content, page.title || '', pageTitle, url);
  if (!company) return null;
  const title = cleanRoleTitle(pageTitle, company);
  const labelledLocation = postingLocation(visible) || 'Location not stated';
  const headingPosition = heading ? content.indexOf(heading) + heading.length : -1;
  const adjacent =
    headingPosition >= 0
      ? content
          .slice(headingPosition)
          .split('\n')
          .map((line) => line.trim())
          .find(Boolean) || ''
      : '';
  const adjacentPlace = placeText(adjacent);
  const hasVisibleLocation =
    adjacent.length <= 160 &&
    !adjacent.startsWith('#') &&
    (Object.values(COUNTRY_AREAS).some((aliases) =>
      aliases.some((alias) => hasPlace(adjacentPlace, alias)),
    ) ||
      hasPlace(adjacentPlace, placeText(p.location)));
  // A role-specific statement provides location evidence; citizenship wording does not.
  const proseLocation = roleContent.description
    .match(
      /(?:\bjoin(?:ing)?\s+(?:our|the)\s+[^.!?]{0,50}?team\s+in|\b(?:this|the)\s+(?:role|position|opportunity)\s+(?:is|will be)\s+(?:based|located)\s+in|\byou\s+(?:will be|are)\s+based\s+in)\s+([^.!?;\n]{2,120})/i,
    )?.[1]
    ?.split(/\s+(?:where|which|with|to help|as part)\b/i)[0]
    ?.trim();
  const hasProseLocation = Boolean(
    proseLocation &&
    !/\b(?:nationals?|citizens?|citizenship|sponsorship|visa)\b/i.test(proseLocation) &&
    (hasRecognizedLocation(proseLocation) ||
      locationEligible(
        { location: proseLocation, workplace: 'onsite', remoteRegion: null },
        p.location,
      )),
  );
  const location =
    labelledLocation === 'Location not stated' ||
    /\[\[|\{\{|^\s*[,;]|^\s*\*|not (?:specified|stated)/i.test(labelledLocation)
      ? hasVisibleLocation
        ? adjacent
        : hasProseLocation
          ? proseLocation!
          : 'Location not stated'
      : labelledLocation;
  const employmentType = /\bintern(?:ship)?\b/i.test(title)
    ? 'internship'
    : /\b(graduate|new grad)\b/i.test(title)
      ? 'graduate'
      : /\b(junior|entry[- ]level|associate|trainee)\b/i.test(title)
        ? 'entry-level'
        : 'unknown';
  const labelledWorkplace = postingWorkplace(visible);
  const workplace =
    labelledWorkplace?.workplace ||
    (/\bhybrid\b/i.test(location)
      ? 'hybrid'
      : /\bremote\b/i.test(location)
        ? 'remote'
        : /\bon[- ]site\b/i.test(location)
          ? 'onsite'
          : 'unknown');
  const job = await normalizeAgentJob(
    {
      title,
      company: sourceCompanyCase(company, content),
      location,
      employmentType,
      workplace,
      sourceUrl: url,
      applyUrl: url,
      description: roleContent.description,
      salary: compensation
        ? { text: compensation.text, currency: compensation.currency, period: compensation.period }
        : null,
      requisitionId:
        content.match(
          /(?:Requisition(?:\s+(?:Number|ID))?|Job\s*(?:ID|Number))\*{0,2}\s*:\*{0,2}\s*([\w-]{3,})/i,
        )?.[1] || null,
      requirements: roleContent.requirements,
      evidence: [
        { field: 'title', text: pageTitle, sourceUrl: url },
        ...(visible.toLowerCase().includes(company.toLowerCase())
          ? [{ field: 'company', text: company, sourceUrl: url }]
          : []),
        ...(location !== 'Location not stated'
          ? [{ field: 'location', text: location, sourceUrl: url }]
          : []),
        ...(labelledWorkplace
          ? [{ field: 'workplace', text: labelledWorkplace.evidence, sourceUrl: url }]
          : []),
        ...(roleContent.description
          ? [{ field: 'listing', text: roleContent.description.slice(0, 650), sourceUrl: url }]
          : []),
        ...(compensation ? [{ field: 'salary', text: compensation.evidence, sourceUrl: url }] : []),
      ],
    },
    url,
    p,
  );
  return job ? verifyJob(job, page, p) : null;
}

export function verifyJob(
  job: Job,
  page: {
    text?: unknown;
    links?: string[];
    final_url?: string;
    url?: string;
    title?: string | null;
  },
  p: SearchPreferences,
): Job {
  const content = typeof page.text === 'string' ? page.text.slice(0, 60_000) : '';
  const final = safePublicUrl(page.final_url || page.url);
  const titleOverlap = words(job.title).filter((word) =>
    words(content.slice(0, 5000)).includes(word),
  ).length;
  const applyLink = (page.links ?? []).some((value) => {
    const link = safePublicUrl(value);
    return Boolean(
      link &&
      new URL(link).hostname === new URL(job.sourceUrl).hostname &&
      /\/(?:apply|oneclick-ui)(?:\/|\?|$)/i.test(new URL(link).pathname),
    );
  });
  const applicationButton = /(?:^|\n)\s*(?:\[)?(?:Apply|I['’]m interested)(?:\]|\s|$)/im.test(
    content,
  );
  const requisition =
    /(?:Requisition(?:\s+(?:Number|ID))?|Job\s*(?:ID|Number))\*{0,2}\s*:\*{0,2}\s*[\w-]{3,}/i.test(
      content,
    );
  const explicitOpen =
    /\b(apply (?:now|for this|to this)|submit (?:your )?application|application form|apply for (?:this|the) (?:job|role|position))\b/i.test(
      content,
    ) ||
    ((applyLink || requisition) && applicationButton);
  const login =
    /\b(sign in to continue|log in to (?:view|continue)|access denied|verify you are human)\b/i.test(
      content.slice(0, 1000),
    );
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedContent = normalize(content);
  const result: Job = {
    ...job,
    checkedAt: new Date().toISOString(),
    availability: CLOSED.test(content)
      ? 'closed'
      : !login &&
          final &&
          isJobDetail(final) &&
          titleOverlap >= Math.min(2, words(job.title).length) &&
          explicitOpen
        ? 'open'
        : 'unverified',
  };
  if (content && !login) {
    const visible = plainText(content);
    const explicitLocation = postingLocation(visible);
    const explicitWorkplace = postingWorkplace(visible);
    if (explicitLocation && !/\[\[|\{\{|not (?:specified|stated)/i.test(explicitLocation))
      result.location = explicitLocation;
    if (explicitWorkplace) {
      result.workplace = explicitWorkplace.workplace;
      if (result.workplace !== 'remote') result.remoteRegion = null;
    }
    const roleContent = extractRoleContent(content);
    const priorDescription = confirmedDescription(
      job.description,
      roleContent.description || content,
    );
    result.description = priorDescription || roleContent.description;
    result.requirements = mergeConfirmedRequirements(job.requirements, roleContent.requirements);
    const freshCompany = employerFromSource(
      content,
      page.title || '',
      job.title,
      final || job.sourceUrl,
    );
    result.company = sourceCompanyCase(freshCompany || job.company, content);
    if (page.title && !/\bcareers?$/i.test(page.title)) {
      const candidate = cleanRoleTitle(page.title, result.company);
      if (
        words(job.title).filter((word) => words(candidate).includes(word)).length >=
        Math.min(2, words(job.title).length)
      )
        result.title = candidate;
    }
    const compensation = extractCompensation(content);
    result.salary = compensation
      ? { text: compensation.text, currency: compensation.currency, period: compensation.period }
      : null;
    result.postedAt = evidenceDate(job.postedAt, content);
    result.deadline = evidenceDate(job.deadline, content);
    result.sponsorship = sponsorshipFromText(content);
    result.evidence = job.evidence.filter(
      (e) =>
        e.field !== 'listing' &&
        e.field !== 'salary' &&
        !(explicitLocation && e.field === 'location') &&
        !(explicitWorkplace && e.field === 'workplace') &&
        (e.sourceUrl !== job.sourceUrl || normalizedContent.includes(normalize(e.text))),
    );
    if (explicitLocation && result.location === explicitLocation)
      result.evidence.push({
        field: 'location',
        text: explicitLocation,
        sourceUrl: final || job.sourceUrl,
      });
    if (explicitWorkplace)
      result.evidence.push({
        field: 'workplace',
        text: explicitWorkplace.evidence,
        sourceUrl: final || job.sourceUrl,
      });
    if (
      visible.toLowerCase().includes(result.company.toLowerCase()) &&
      !result.evidence.some((e) => e.field === 'company' && e.text === result.company)
    )
      result.evidence.push({
        field: 'company',
        text: result.company,
        sourceUrl: final || job.sourceUrl,
      });
    if (result.description)
      result.evidence.push({
        field: 'listing',
        text: result.description.slice(0, 650),
        sourceUrl: final || job.sourceUrl,
      });
    if (compensation)
      result.evidence.push({
        field: 'salary',
        text: compensation.evidence,
        sourceUrl: final || job.sourceUrl,
      });
    if (
      job.applyUrl !== job.sourceUrl &&
      !(page.links ?? []).some((link) => safePublicUrl(link) === job.applyUrl)
    )
      result.applyUrl = job.sourceUrl;
  }
  const evidenceLine = content
    .split('\n')
    .find(
      (line) =>
        CLOSED.test(line) ||
        /apply now|submit (?:your )?application|^\s*(?:\[)?(?:Apply|I['’]m interested)(?:\]|\s|$)/i.test(
          line,
        ),
    );
  if (evidenceLine)
    result.evidence = [
      ...result.evidence.filter((e) => e.field !== 'availability'),
      {
        field: 'availability',
        text: evidenceLine.slice(0, 500),
        sourceUrl: final || job.sourceUrl,
      },
    ].slice(0, 12);
  if (deadlinePassed(result.deadline)) result.availability = 'closed';
  result.match = scoreJob(result, p);
  return result;
}

function individualJobUrl(value: string): string | null {
  const safe = safePublicUrl(value);
  if (!safe) return null;
  const parsed = new URL(safe);
  const idKeys = new Set([
    'jobid',
    'job_id',
    'gh_jid',
    'requisitionid',
    'requisition_id',
    'reqid',
    'positionid',
    'position_id',
  ]);
  const identifiedQuery = [...parsed.searchParams].some(
    ([key, id]) =>
      idKeys.has(key.toLowerCase()) &&
      /^[a-z\d][a-z\d._-]{0,127}$/i.test(id) &&
      !/^(?:new|all|search|apply|unknown)$/i.test(id),
  );
  // Careers homepages, search pages and general application forms identify no individual opening.
  const generic =
    /\/(?:jobs?|positions?|requisitions?)\/(?:search|results|all|browse|apply|application|login|register|talent[-_]pool|join)(?:\/|$)/i.test(
      parsed.pathname,
    );
  const specificApplication =
    /\/(?:apply|application)\/(?:\d+|[a-f\d]{8}-[a-f\d-]{15,})(?:\/|$)/i.test(parsed.pathname) ||
    /\/(?:oneclick-ui)\/company\/[^/]+\/publication\/\d+(?:\/|$)/i.test(parsed.pathname);
  if (
    !identifiedQuery &&
    ((generic && !specificApplication) || (!isJobDetail(safe) && !specificApplication))
  )
    return null;
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (/\/apply$/i.test(parsed.pathname)) {
    const detail = new URL(parsed);
    detail.pathname = detail.pathname.replace(/\/apply$/i, '');
    if (isJobDetail(detail.href)) parsed.pathname = detail.pathname;
  }
  parsed.searchParams.sort();
  return parsed.href;
}

function requisition(value: string | null): string | null {
  const clean = value?.trim().toLowerCase();
  return clean && !/^(?:unknown|not stated|n\/?a|null|none|-+)$/.test(clean) ? clean : null;
}

export function deduplicate(jobs: Job[]): Job[] {
  const identities = jobs.map((job) => {
    const source = individualJobUrl(job.sourceUrl);
    const apply = individualJobUrl(job.applyUrl);
    const req = requisition(job.requisitionId);
    const company = job.company.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const knownCompany = company && !/^(?:unknown|companynotstated|notstated|na)$/.test(company);
    const applyObserved =
      job.availability !== 'unverified' ||
      job.evidence.some(
        (e) =>
          /^(?:apply_?url|application_?url|apply(?: link)?|application(?: link)?)$/i.test(
            e.field,
          ) &&
          (individualJobUrl(e.sourceUrl) === apply || e.text.includes(job.applyUrl)),
      );
    return {
      source,
      req,
      key: req && knownCompany ? `${company}|${req}` : null,
      destinations: new Set(
        [source, applyObserved ? apply : null].filter((url): url is string => Boolean(url)),
      ),
    };
  });
  const parents = jobs.map((_, index) => index);
  const reqs = identities.map((identity) => new Set(identity.req ? [identity.req] : []));
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const merge = (left: number, right: number) => {
    const a = root(left),
      b = root(right);
    if (a === b) return;
    parents[b] = a;
    for (const req of reqs[b]) reqs[a].add(req);
  };
  // Strong identities are resolved first. An authoritative source URL can be reused or corrected,
  // so two observations of that exact source still represent one rendered listing.
  for (let i = 0; i < jobs.length; i++)
    for (let j = i + 1; j < jobs.length; j++) {
      const a = identities[i],
        b = identities[j];
      if ((a.source && a.source === b.source) || (a.key && a.key === b.key)) merge(i, j);
    }
  const destinationReqs = new Map<string, Set<string>>();
  for (const [index, identity] of identities.entries())
    for (const url of identity.destinations) {
      const known = destinationReqs.get(url) || new Set<string>();
      for (const req of reqs[root(index)]) known.add(req);
      destinationReqs.set(url, known);
    }
  // A corroborated individual application URL is secondary evidence. Conflicting requisitions
  // block this weaker alias; identical titles or locations never contribute an identity.
  for (let i = 0; i < jobs.length; i++)
    for (let j = i + 1; j < jobs.length; j++) {
      const a = root(i),
        b = root(j);
      if (a === b || new Set([...reqs[a], ...reqs[b]]).size > 1) continue;
      if (
        [...identities[i].destinations].some(
          (url) =>
            identities[j].destinations.has(url) && (destinationReqs.get(url)?.size || 0) <= 1,
        )
      )
        merge(i, j);
    }
  const unique = new Map<number, Job>();
  const certainty = (job: Job) => (job.availability === 'unverified' ? 0 : 1);
  const checked = (job: Job) =>
    Number.isFinite(Date.parse(job.checkedAt)) ? Date.parse(job.checkedAt) : -Infinity;
  for (const [index, job] of jobs.entries()) {
    const key = root(index),
      previous = unique.get(key);
    if (
      !previous ||
      certainty(job) > certainty(previous) ||
      (certainty(job) === certainty(previous) &&
        (checked(job) > checked(previous) ||
          (checked(job) === checked(previous) &&
            ((job.availability === 'closed' && previous.availability !== 'closed') ||
              (job.availability === previous.availability &&
                job.evidence.length > previous.evidence.length)))))
    )
      unique.set(key, job);
  }
  return [...unique.values()].sort(
    (a, b) => b.match.score - a.match.score || a.title.localeCompare(b.title),
  );
}

export function fingerprintInput(p: SearchPreferences): string {
  return JSON.stringify({
    role: p.role.toLowerCase(),
    location: p.location.toLowerCase(),
    keywords: p.keywords.toLowerCase(),
    jobTypes: [...p.jobTypes].sort(),
    workplaces: [...p.workplaces].sort(),
    postedWithinDays: p.postedWithinDays,
    sponsorshipRequired: p.sponsorshipRequired,
  });
}
