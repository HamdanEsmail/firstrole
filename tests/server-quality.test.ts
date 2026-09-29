import { describe, expect, it } from 'vitest';
import type { Job, SearchPreferences } from '../shared/types';
import { boundedJson, safePublicUrl } from '../server/http';
import {
  deduplicate,
  eligible,
  extractPageJob,
  fingerprintInput,
  isJobDetail,
  locationEligible,
  normalizeAgentJob,
  scoreJob,
  sourceCandidate,
  validatePreferences,
  verifyJob,
} from '../server/quality';

const preferences: SearchPreferences = {
  role: 'Data analyst',
  location: 'Dubai',
  keywords: 'SQL',
  jobTypes: ['internship', 'entry-level'],
  workplaces: [],
  sponsorshipRequired: false,
  postedWithinDays: null,
};
const sourceUrl = 'https://careers.example.com/jobs/123';
function fixture(extra: Partial<Job> = {}): Job {
  return {
    id: 'a'.repeat(64),
    title: 'Junior Data Analyst',
    company: 'Example',
    location: 'Dubai',
    workplace: 'onsite',
    remoteRegion: null,
    employmentType: 'entry-level',
    sourceUrl,
    applyUrl: sourceUrl,
    requisitionId: '123',
    description: 'SQL analysis.',
    requirements: ['SQL'],
    salary: null,
    postedAt: null,
    deadline: null,
    checkedAt: '2026-09-29T10:00:00Z',
    sponsorship: 'not-stated',
    evidence: [{ field: 'title', text: 'Junior Data Analyst', sourceUrl }],
    availability: 'open',
    match: { score: 90, tier: 'Strong match', reasons: [] },
    ...extra,
  };
}

describe('source integrity and response bounds', () => {
  it.each([
    'http://example.com/jobs/1',
    'https://127.0.0.1/jobs/1',
    'https://0x7f000001/jobs/1',
    'https://[::1]/jobs/1',
    'https://localhost/jobs/1',
    'https://app.internal/jobs/1',
    'https://user:pass@example.com/jobs/1',
    'javascript:alert(1)',
    'https://example.com:8443/jobs/1',
  ])('rejects unsafe URL %s', (url) => expect(safePublicUrl(url)).toBeNull());
  it('removes tracking while preserving job identifiers', () =>
    expect(safePublicUrl('https://careers.example.com/jobs/1?gh_jid=42&utm_source=x#apply')).toBe(
      'https://careers.example.com/jobs/1?gh_jid=42',
    ));
  it('rejects articles as career sources', () =>
    expect(sourceCandidate('https://example.com/blog/best-jobs')).toBeNull());
  it('limits streamed bodies even without Content-Length', async () => {
    await expect(
      boundedJson(new Response(JSON.stringify({ large: 'a'.repeat(500) })), 32),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('rejects malformed upstream JSON', async () =>
    expect(boundedJson(new Response('not json'))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    }));
});

describe('preferences and fit', () => {
  it('requires a role, location, and opportunity type', () =>
    expect(() => validatePreferences({ role: 'x', location: '', jobTypes: [] })).toThrow());
  it('normalizes fingerprints across filter order', () =>
    expect(fingerprintInput({ ...preferences, jobTypes: ['internship', 'entry-level'] })).toBe(
      fingerprintInput({
        ...preferences,
        role: 'DATA ANALYST',
        jobTypes: ['entry-level', 'internship'],
      }),
    ));
  it('never labels a different physical location a strong match', () =>
    expect(scoreJob(fixture({ location: 'New York' }), preferences).tier).toBe('Possible match'));
  it('does not imply worldwide eligibility from remote alone', () =>
    expect(scoreJob(fixture({ workplace: 'remote', remoteRegion: null }), preferences).tier).toBe(
      'Possible match',
    ));
  it('excludes explicit senior, closed and incompatible sponsorship roles', () => {
    expect(eligible(fixture({ title: 'Senior Data Analyst' }), preferences)).toBe(false);
    expect(eligible(fixture({ availability: 'closed' }), preferences)).toBe(false);
    expect(
      eligible(fixture({ sponsorship: 'unavailable' }), {
        ...preferences,
        sponsorshipRequired: true,
      }),
    ).toBe(false);
  });
  it('keeps unknown sponsorship honestly labelled', () =>
    expect(scoreJob(fixture(), { ...preferences, sponsorshipRequired: true }).reasons).toContain(
      'Sponsorship eligibility needs checking',
    ));
  it('excludes unknown sponsorship under the explicitly-offered filter', () => {
    expect(eligible(fixture(), { ...preferences, sponsorshipRequired: true })).toBe(false);
    expect(
      eligible(fixture({ sponsorship: 'available' }), {
        ...preferences,
        sponsorshipRequired: true,
      }),
    ).toBe(true);
  });
  it('excludes unknown workplace only when a workplace filter is selected', () => {
    expect(
      eligible(fixture({ workplace: 'unknown' }), { ...preferences, workplaces: ['onsite'] }),
    ).toBe(false);
    expect(eligible(fixture({ workplace: 'unknown' }), preferences)).toBe(true);
  });
  it('requires evidenced dates under the posting date filter', () => {
    expect(eligible(fixture(), { ...preferences, postedWithinDays: 7 })).toBe(false);
    expect(
      eligible(fixture({ postedAt: new Date(Date.now() - 86_400_000).toISOString() }), {
        ...preferences,
        postedWithinDays: 7,
      }),
    ).toBe(true);
  });
  it('never admits an unknown early-career type under opportunity filters', () =>
    expect(
      eligible(fixture({ employmentType: 'unknown' }), {
        ...preferences,
        jobTypes: ['internship', 'graduate', 'entry-level'],
      }),
    ).toBe(false));
  it('excludes mismatched and unknown locations instead of retaining possible matches', () => {
    expect(eligible(fixture({ location: 'New York' }), preferences)).toBe(false);
    expect(eligible(fixture({ location: 'Location not stated' }), preferences)).toBe(false);
    expect(
      eligible(
        fixture({ location: 'Remote', workplace: 'remote', remoteRegion: 'US only' }),
        preferences,
      ),
    ).toBe(false);
    expect(
      eligible(
        fixture({ location: 'Remote', workplace: 'remote', remoteRegion: null }),
        preferences,
      ),
    ).toBe(false);
  });
  it('matches clear country coverage and remote eligibility without broadening a requested city', () => {
    expect(locationEligible(fixture({ location: 'Dubai' }), 'United Arab Emirates')).toBe(true);
    expect(locationEligible(fixture({ location: 'Abu Dhabi, UAE' }), 'Dubai, UAE')).toBe(false);
    expect(
      locationEligible(
        fixture({ location: 'Remote', workplace: 'remote', remoteRegion: 'UAE' }),
        'Dubai',
      ),
    ).toBe(true);
    expect(
      locationEligible(
        fixture({ location: 'Remote', workplace: 'remote', remoteRegion: 'Worldwide' }),
        'Dubai',
      ),
    ).toBe(true);
  });
});

describe('source-grounded listing normalization', () => {
  it('rejects unsupported listing records without evidence or individual URLs', async () => {
    expect(
      await normalizeAgentJob(
        { title: 'Junior Analyst', company: 'Example', sourceUrl, applyUrl: sourceUrl },
        sourceUrl,
        preferences,
      ),
    ).toBeNull();
    expect(
      await normalizeAgentJob(
        {
          title: 'Junior Analyst',
          company: 'Example',
          sourceUrl: 'https://careers.example.com/',
          applyUrl: sourceUrl,
          evidence: [{ text: 'Analyst', field: 'title', sourceUrl }],
        },
        sourceUrl,
        preferences,
      ),
    ).toBeNull();
  });
  it('keeps missing salary, sponsorship and dates unknown', async () => {
    const job = await normalizeAgentJob(
      {
        title: 'Junior Data Analyst',
        company: 'Example',
        sourceUrl,
        applyUrl: sourceUrl,
        postedAt: '2026-09-28',
        sponsorship: 'available',
        evidence: [{ field: 'title', text: 'Junior Data Analyst', sourceUrl }],
      },
      sourceUrl,
      preferences,
    );
    expect(job).toMatchObject({
      postedAt: null,
      salary: null,
      sponsorship: 'not-stated',
      availability: 'unverified',
    });
  });
  it('requires a visible application cue before calling a job open', () => {
    expect(
      verifyJob(
        fixture(),
        { url: sourceUrl, text: 'Junior Data Analyst. Company introduction.' },
        preferences,
      ).availability,
    ).toBe('unverified');
    expect(
      verifyJob(fixture(), { url: sourceUrl, text: 'Junior Data Analyst. Apply now.' }, preferences)
        .availability,
    ).toBe('open');
  });
  it('recognizes closed text even when an old Apply link remains', () =>
    expect(
      verifyJob(
        fixture(),
        { url: sourceUrl, text: 'Junior Data Analyst. This position has been filled. Apply now.' },
        preferences,
      ).availability,
    ).toBe('closed'));
  it('strips unsupported compensation and unlinked application URLs on refresh', () => {
    const job = verifyJob(
      fixture({
        salary: { text: '$100,000', currency: 'USD', period: 'year' },
        applyUrl: 'https://other.example.com/apply',
      }),
      { url: sourceUrl, text: 'Junior Data Analyst. Apply now.', links: [] },
      preferences,
    );
    expect(job.salary).toBeNull();
    expect(job.applyUrl).toBe(sourceUrl);
  });
  it('can parse an actual direct listing without inventing a company', async () => {
    const job = await extractPageJob(
      {
        url: sourceUrl,
        title: 'Junior Data Analyst at Example',
        text: '# Junior Data Analyst at Example\nLocation: Dubai\n- SQL\nApply now',
      },
      preferences,
    );
    expect(job).toMatchObject({
      company: 'Example',
      location: 'Dubai',
      employmentType: 'entry-level',
      availability: 'open',
    });
    expect(
      await extractPageJob(
        { url: sourceUrl, title: 'Junior Data Analyst', text: 'Junior Data Analyst. Apply now.' },
        preferences,
      ),
    ).toBeNull();
  });
  it('deduplicates requisitions while preferring a verified source over richer unverified claims', () => {
    const verified = fixture();
    const unverified = fixture({
      id: 'b'.repeat(64),
      sourceUrl: 'https://other.example.com/jobs/123',
      availability: 'unverified',
      evidence: [...verified.evidence, ...verified.evidence],
    });
    expect(deduplicate([verified, unverified])).toEqual([verified]);
  });
  it('a later confirmed closure supersedes an older open snapshot', () => {
    const closed = fixture({ availability: 'closed', checkedAt: '2026-09-29T11:00:00Z' });
    expect(deduplicate([fixture(), closed])[0].availability).toBe('closed');
  });
  it.each([
    'Sponsorship is not available.',
    'Sponsorship for U.S. employment authorization is not available for this position.',
    'No employer sponsorship is available.',
  ])('respects explicit sponsorship negation: %s', (sentence) => {
    const job = verifyJob(
      fixture(),
      { url: sourceUrl, text: `Junior Data Analyst. Apply now. ${sentence}` },
      preferences,
    );
    expect(job.sponsorship).toBe('unavailable');
    expect(eligible(job, { ...preferences, sponsorshipRequired: true })).toBe(false);
  });
  it('recognizes public SmartRecruiters and legacy AECOM detail URLs', () => {
    expect(
      isJobDetail(
        'https://jobs.smartrecruiters.com/AECOM2/744000152212175-civil-engineering-transit-intern',
      ),
    ).toBe(true);
    expect(
      isJobDetail('https://aecom.jobs/dubai-are/intern/4A39A1BE369F439888FCF645D85C9C42/job/'),
    ).toBe(true);
  });
  it('parses Workday markdown headings and location labels', async () => {
    const url = 'https://pjtpartners.wd1.myworkdayjobs.com/Students/job/Dubai/Analyst_R123';
    const job = await extractPageJob(
      {
        url,
        title: 'Careers',
        text: '### PJT Partners - Students\n## Graduate Data Analyst\n**locations**:\nDubai\nApply',
        links: [`${url}/apply`],
      },
      preferences,
    );
    expect(job).toMatchObject({
      title: 'Graduate Data Analyst',
      company: 'PJT Partners',
      location: 'Dubai',
      availability: 'open',
    });
  });
  it('recognizes a SmartRecruiters application action without fabricating open status from any link', () => {
    const url = 'https://jobs.smartrecruiters.com/Example/123456789-intern';
    const job = fixture({ sourceUrl: url, applyUrl: url });
    expect(
      verifyJob(
        job,
        {
          url,
          text: 'Junior Data Analyst\nI’m interested',
          links: [
            'https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/123456789',
          ],
        },
        preferences,
      ).availability,
    ).toBe('open');
    expect(
      verifyJob(
        job,
        {
          url,
          text: 'Junior Data Analyst\nI’m interested',
          links: ['https://jobs.smartrecruiters.com/about'],
        },
        preferences,
      ).availability,
    ).toBe('unverified');
  });
});
