import { describe, expect, it } from 'vitest';
import type { Job, SearchPreferences } from '../shared/types';
import { boundedJson, safePublicUrl } from '../server/http';
import {
  deduplicate,
  deadlinePassed,
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

describe('source-evidenced closing dates', () => {
  it('excludes past closing dates while treating the stated closing day as inclusive', () => {
    const now = Date.parse('2026-09-30T15:00:00Z');
    expect(deadlinePassed('2026-09-29T00:00:00Z', now)).toBe(true);
    expect(deadlinePassed('2026-09-30T00:00:00Z', now)).toBe(false);
    expect(deadlinePassed(null, now)).toBe(false);
    expect(deadlinePassed('unreadable', now)).toBe(false);
    expect(eligible(fixture({ deadline: '2000-01-01T00:00:00Z' }), preferences)).toBe(false);
  });

  it('does not call an expired listing open merely because an Apply button remains', () => {
    const result = verifyJob(
      fixture({ deadline: '2000-01-01T00:00:00Z' }),
      {
        url: sourceUrl,
        text: '# Junior Data Analyst\nApplication deadline: 2000-01-01\nApply now',
      },
      preferences,
    );
    expect(result.deadline).toBeTruthy();
    expect(result.availability).toBe('closed');
  });
});

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
  it('matches company and qualification keywords as preferences without weakening required filters', () => {
    const job = fixture({
      company: 'AECOM',
      description: 'Prepare technical plans.',
      requirements: ['Experience with SQL and BIM.'],
    });
    const withKeywords = { ...preferences, keywords: 'SQL BIM AECOM' };
    expect(scoreJob(job, withKeywords).reasons).toContain('Mentions sql, bim, aecom');
    expect(scoreJob(job, withKeywords).score).toBeGreaterThan(
      scoreJob(job, { ...preferences, keywords: '' }).score,
    );
    expect(eligible({ ...job, availability: 'closed' }, withKeywords)).toBe(false);
  });
  it('keeps cache identity after PostgreSQL JSONB reorders preference properties', () => {
    const apiPreferences = validatePreferences(preferences);
    const storedPreferences = Object.fromEntries(
      Object.entries(apiPreferences).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)),
    ) as unknown as SearchPreferences;
    expect(Object.keys(storedPreferences)).not.toEqual(Object.keys(apiPreferences));
    expect(fingerprintInput(storedPreferences)).toBe(fingerprintInput(apiPreferences));
    expect(fingerprintInput({ ...apiPreferences, sponsorshipRequired: true })).not.toBe(
      fingerprintInput(apiPreferences),
    );
  });
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
  it('uses a Workday tenant as employer and preserves a seasonal role subtitle', async () => {
    const url =
      'https://medtronic.wd1.myworkdayjobs.com/en-US/MedtronicCareers/job/Software-Engineering-Intern---Summer-2027_R73630-1';
    const page = {
      url,
      title: 'Software Engineering Intern – Summer 2027',
      text: 'Medtronic uses cookies.\n## Software Engineering Intern – Summer 2027\n**locations**: US, Minnesota, Minneapolis\n## Job Description\nBuild medical software.\n**job requisition id**: R73630\nApply',
      links: [`${url}/apply`],
    };
    const job = await extractPageJob(page, {
      ...preferences,
      role: 'Software engineer',
      location: 'United States',
    });
    expect(job).toMatchObject({
      company: 'Medtronic',
      title: 'Software Engineering Intern – Summer 2027',
      employmentType: 'internship',
    });
    const refreshed = verifyJob(
      { ...job!, company: 'Summer 2027', title: 'Software Engineering Intern' },
      page,
      { ...preferences, role: 'Software engineer', location: 'United States' },
    );
    expect(refreshed.company).toBe('Medtronic');
    expect(refreshed.title).toBe('Software Engineering Intern – Summer 2027');
  });
  it('extracts Egis geography only from its explicit role-location sentence', async () => {
    const url =
      'https://jobs.smartrecruiters.com/EgisGroup/744000106009115-graduate-mechanical-engineer-mep-uae-national-';
    const job = await extractPageJob(
      {
        url,
        title: 'Graduate Mechanical Engineer- MEP (UAE National)',
        text: '# Graduate Mechanical Engineer- MEP (UAE National)\n\n* Full-time\n* Region: Middle East and South Asia\n\n## Company Description\n\nEgis is an international engineering group.\n\n## Job Description\n\nWe are seeking a Graduate Mechanical Engineer (UAE National) specialising in MEP systems to join our growing team in Dubai, United Arab Emirates.\n\n## Qualifications\n\n* A degree in mechanical engineering.',
      },
      {
        ...preferences,
        role: 'Engineering',
        location: 'United Arab Emirates',
        jobTypes: ['graduate'],
      },
    );
    expect(job).toMatchObject({
      company: 'Egis',
      location: 'Dubai, United Arab Emirates',
      employmentType: 'graduate',
      availability: 'unverified',
    });
    expect(
      eligible(job!, {
        ...preferences,
        role: 'Engineering',
        location: 'United Arab Emirates',
        jobTypes: ['graduate'],
      }),
    ).toBe(true);
  });
  it('does not infer geography from UAE-national eligibility or a regional business label', async () => {
    const url = 'https://jobs.smartrecruiters.com/EgisGroup/744000106009115-graduate-engineer';
    const job = await extractPageJob(
      {
        url,
        title: 'Graduate Engineer (UAE National)',
        text: '# Graduate Engineer (UAE National)\n* Full-time\n* Region: Middle East and South Asia\n## Company Description\nEgis is an engineering group.\n## Job Description\nApplicants must be UAE Nationals. Build useful engineering systems.',
      },
      preferences,
    );
    expect(job?.location).toBe('Location not stated');
  });
  it('rejects a generic Workday careers shell without inventing a role from its URL', async () => {
    const url =
      'https://kbr.wd5.myworkdayjobs.com/kbr_careers/job/Project-Planner-Graduate-Engineer---UAE--Emirati-Nationals-Only_R2128569';
    expect(
      await extractPageJob(
        {
          url,
          title: 'KBR Careers',
          text: 'KBR Careers\nWelcome to our careers website.\nSign in\nPrivacy notice',
        },
        preferences,
      ),
    ).toBeNull();
  });
  it('parses the observed Halliburton layout without treating its city placeholder as a location', async () => {
    const url =
      'https://careers.halliburton.com/job/united-arab-emirates/intern-and-entry-level-graduate/543/100976776112';
    const job = await extractPageJob(
      {
        url,
        title: 'Intern & Entry Level Graduate at Halliburton',
        text: '# Job Details\n## Recognized in Red\n## Intern & Entry Level Graduate\n\nUnited Arab Emirates\n\n### Job Description\nEntry level engineering work.\n**Location**\n\n, [[city]], , ,\n\n**Requisition Number:** 211894\nApply',
        links: [],
      },
      { ...preferences, location: 'United Arab Emirates' },
    );
    expect(job).toMatchObject({
      title: 'Intern & Entry Level Graduate',
      company: 'Halliburton',
      location: 'United Arab Emirates',
      employmentType: 'internship',
      requisitionId: '211894',
      availability: 'open',
    });
    expect(eligible(job!, { ...preferences, location: 'United Arab Emirates' })).toBe(true);
  });
  it('does not invent a location when both the location label and title-adjacent evidence are missing', async () => {
    const job = await extractPageJob(
      {
        url: sourceUrl,
        title: 'Engineering Intern at Example',
        text: '# Job Details\n## Engineering Intern\n### Job Description\nBuild systems.\n**Location**\n[[city]]\nApply',
      },
      preferences,
    );
    expect(job?.location).toBe('Location not stated');
    expect(eligible(job!, preferences)).toBe(false);
  });
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
  it('preserves distinct same-title/location seasonal internships without requisition IDs', () => {
    const summerUrl = 'https://boards.greenhouse.io/example/jobs/1111';
    const winterUrl = 'https://boards.greenhouse.io/example/jobs/2222';
    const summer = fixture({
      title: 'Software Engineering Intern',
      requisitionId: null,
      sourceUrl: summerUrl,
      applyUrl: summerUrl,
      description: 'Summer internship.',
    });
    const winter = fixture({
      id: 'b'.repeat(64),
      title: summer.title,
      requisitionId: null,
      sourceUrl: winterUrl,
      applyUrl: winterUrl,
      description: 'Winter internship.',
    });
    expect(deduplicate([summer, winter])).toHaveLength(2);
    expect(deduplicate([winter, summer])).toHaveLength(2);
  });
  it('merges canonical source observations despite tracking, query order, or corrected requisitions', () => {
    const first = fixture({
      requisitionId: 'OLD123',
      sourceUrl: 'https://careers.example.com/jobs/123/?locale=en&job_id=123&utm_source=board',
    });
    const latest = fixture({
      id: 'b'.repeat(64),
      requisitionId: 'NEW456',
      sourceUrl: 'https://careers.example.com/jobs/123?job_id=123&locale=en',
      checkedAt: '2026-09-29T12:00:00Z',
      availability: 'closed',
    });
    expect(deduplicate([first, latest])).toEqual([latest]);
    expect(deduplicate([latest, first])).toEqual([latest]);
  });
  it('keeps employer requisitions distinct across different companies', () => {
    const one = fixture({
      company: 'Employer One',
      sourceUrl: 'https://one.example/jobs/123',
      applyUrl: 'https://one.example/jobs/123',
    });
    const two = fixture({
      company: 'Employer Two',
      id: 'b'.repeat(64),
      sourceUrl: 'https://two.example/jobs/123',
      applyUrl: 'https://two.example/jobs/123',
    });
    expect(deduplicate([one, two])).toHaveLength(2);
  });
  it.each([
    'https://careers.example.com/',
    'https://careers.example.com/jobs',
    'https://careers.example.com/apply',
    'https://careers.example.com/jobs/apply',
    'https://careers.example.com/jobs/search',
    'https://careers.example.com/apply/step1',
  ])('never aliases separate jobs through the general application destination %s', (applyUrl) => {
    const first = fixture({ requisitionId: null, applyUrl });
    const second = fixture({
      id: 'b'.repeat(64),
      requisitionId: null,
      sourceUrl: 'https://careers.example.com/jobs/456',
      applyUrl,
    });
    expect(deduplicate([first, second])).toHaveLength(2);
  });
  it('merges corroborated individual application destinations, including a detail/apply pair', () => {
    const direct = fixture({ requisitionId: null });
    const mirror = fixture({
      id: 'b'.repeat(64),
      requisitionId: null,
      sourceUrl: 'https://other.example/jobs/mirrored-opening',
      applyUrl: `${sourceUrl}/apply`,
      checkedAt: '2026-09-29T12:00:00Z',
    });
    expect(deduplicate([direct, mirror])).toEqual([mirror]);
  });
  it('does not merge an unverified application claim without observed link evidence', () => {
    const direct = fixture({ requisitionId: null });
    const mirror = fixture({
      id: 'b'.repeat(64),
      requisitionId: null,
      sourceUrl: 'https://other.example/jobs/mirrored-opening',
      applyUrl: `${sourceUrl}/apply`,
      availability: 'unverified',
    });
    expect(deduplicate([direct, mirror])).toHaveLength(2);
    const observed = {
      ...mirror,
      evidence: [
        { field: 'applyUrl', text: 'Apply for this position', sourceUrl: mirror.applyUrl },
      ],
    };
    expect(deduplicate([direct, observed])).toEqual([direct]);
  });
  it('blocks a shared application alias when distinct requisitions make it ambiguous', () => {
    const applyUrl = 'https://ats.example/jobs/123/apply';
    const first = fixture({
      sourceUrl: 'https://one.example/jobs/111',
      requisitionId: '111',
      applyUrl,
    });
    const second = fixture({
      id: 'b'.repeat(64),
      sourceUrl: 'https://two.example/jobs/222',
      requisitionId: '222',
      applyUrl,
    });
    const unknown = fixture({
      id: 'c'.repeat(64),
      sourceUrl: 'https://three.example/jobs/333',
      requisitionId: null,
      applyUrl,
    });
    expect(deduplicate([first, second, unknown])).toHaveLength(3);
    expect(deduplicate([unknown, second, first])).toHaveLength(3);
  });
  it('preserves transitive concrete aliases even when the preferred snapshot changes', () => {
    const first = fixture({
      sourceUrl: 'https://one.example/jobs/111',
      applyUrl: 'https://one.example/jobs/111',
    });
    const second = fixture({
      id: 'b'.repeat(64),
      sourceUrl: 'https://two.example/jobs/222',
      applyUrl: 'https://two.example/jobs/222',
    });
    const third = fixture({
      id: 'c'.repeat(64),
      requisitionId: null,
      sourceUrl: 'https://three.example/jobs/333',
      applyUrl: `${second.sourceUrl}/apply`,
      availability: 'closed',
      checkedAt: '2026-09-29T12:00:00Z',
    });
    expect(deduplicate([first, second, third])).toEqual([third]);
    expect(deduplicate([third, second, first])).toEqual([third]);
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
  it('reads SmartRecruiters bullet metadata and prefers the job location over a recruiting-event city', async () => {
    const url =
      'https://jobs.smartrecruiters.com/AECOM2/744000150786409-civil-highway-engineer-intern-hiring-event-with-aecom-philadelphia';
    const text = `# Civil/Highway Engineer Intern - Hiring Event with AECOM - Philadelphia
* Intern
* Legal Entity: AECOM Technical Services Inc
* Work Location Model: Hybrid
* Location: Philadelphia, Pennsylvania
* Primary Location: US - Newark, DE - 248 Chapman Rd
* Compensation: USD 21 - USD 26 - hourly
## Company Description
Work with Us. Change the World.
## Job Description
AECOM is hosting a hiring event in Philadelphia.
AECOM is seeking a Highway Engineer Intern to be based in Newark, Delaware.
You will prepare roadway designs and engineering calculations.
## Qualifications
* Candidates must be pursuing a degree in Civil Engineering.
## Additional Information
* Sponsorship for US employment authorization is not available now or in the future.
I'm interested`;
    const prefs = {
      ...preferences,
      role: 'Civil engineering',
      location: 'United States',
      jobTypes: ['internship' as const],
      workplaces: ['hybrid' as const],
    };
    const page = {
      url,
      title: 'Civil/Highway Engineer Intern - Hiring Event with AECOM - Philadelphia',
      text,
      links: [],
    };
    const job = await extractPageJob(page, prefs);
    expect(job).toMatchObject({
      company: 'AECOM Technical Services Inc',
      location: 'US - Newark, DE - 248 Chapman Rd',
      workplace: 'hybrid',
      employmentType: 'internship',
      sponsorship: 'unavailable',
      salary: { text: 'USD 21 - USD 26 - hourly', currency: 'USD', period: 'hourly' },
    });
    expect(job!.location).not.toContain('Philadelphia');
    expect(eligible(job!, prefs)).toBe(true);
    expect(eligible(job!, { ...prefs, location: 'Philadelphia' })).toBe(false);
    expect(eligible(job!, { ...prefs, sponsorshipRequired: true })).toBe(false);
    expect(job!.evidence).toContainEqual({
      field: 'company',
      text: 'AECOM Technical Services Inc',
      sourceUrl: url,
    });
    const refreshed = verifyJob(
      { ...job!, company: 'AECOM2', location: 'Philadelphia', workplace: 'unknown' },
      page,
      prefs,
    );
    expect(refreshed).toMatchObject({
      company: 'AECOM Technical Services Inc',
      location: 'US - Newark, DE - 248 Chapman Rd',
      workplace: 'hybrid',
    });
  });
  it('does not borrow bullet metadata from a related-job card', async () => {
    const page = {
      url: 'https://jobs.smartrecruiters.com/Example/744000150786410-engineering-intern',
      title: 'Engineering Intern',
      text: '# Engineering Intern\n## Job Description\nBuild engineering tools.\n## Related jobs\n# Engineering Intern in Dubai\n* Primary Location: Dubai, United Arab Emirates\n* Legal Entity: Unrelated Employer Inc\n* Work Location Model: Hybrid',
    };
    const parsed = await extractPageJob(page, { ...preferences, role: 'Engineering' });
    expect(parsed?.location).toBe('Location not stated');
    expect(parsed?.company).not.toBe('Unrelated Employer Inc');
    expect(parsed?.workplace).toBe('unknown');
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
