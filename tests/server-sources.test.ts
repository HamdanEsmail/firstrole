import { describe, expect, it } from 'vitest';
import type { SearchPreferences } from '../shared/types';
import { listingClosed } from '../server/quality';
import {
  discoveryQueries,
  observedJobLinks,
  selectAgentSource,
  selectFollowupUrls,
  selectSourceUrls,
  sourceRelevance,
} from '../server/sources';

const preferences: SearchPreferences = {
  role: 'Engineering',
  location: 'United Arab Emirates',
  jobTypes: ['internship', 'graduate', 'entry-level'],
  workplaces: [],
  keywords: '',
  sponsorshipRequired: false,
  postedWithinDays: null,
};

describe('live-discovery source selection regressions', () => {
  it('does not re-fetch an observed SmartRecruiters job solely because it has trid tracking', () => {
    const url = 'https://jobs.smartrecruiters.com/EgisGroup/744000123456789-graduate-engineer';
    expect(
      observedJobLinks({ url, links: [`${url}?trid=marketing-campaign`] }, preferences, [url]),
    ).toEqual([]);
  });
  it('rejects application variants, malformed Google paths and internet substring false positives', () => {
    const links = [
      'https://intel.wd1.myworkdayjobs.com/en-US/External/job/software-engineering-intern_JR123/apply',
      'https://www.google.com/about/careers/applications/jobs/results/jobs/results/123-software-engineer-intern',
      'https://www.google.com/about/careers/applications/jobs/results/124-software-engineer-iii-internet-traffic',
      'https://jobs.example.com/jobs/software-engineering-internship',
    ];
    expect(observedJobLinks({ url: 'https://jobs.example.com', links }, preferences, [])).toEqual([
      'https://jobs.example.com/jobs/software-engineering-internship',
    ]);
    expect(selectFollowupUrls([links[0]], [])).toEqual([]);
  });
  it('follows only observed relevant early-career job links and skips unrelated or unsafe URLs', () => {
    const page = {
      url: 'https://careers.example.com/',
      links: [
        'https://careers.example.com/jobs/engineering-intern',
        'https://careers.example.com/jobs/senior-engineer',
        'https://careers.example.com/jobs/finance-intern',
        'http://127.0.0.1/jobs/engineering-intern',
      ],
      text: '[Graduate Engineer](https://careers.example.com/jobs/123)',
    };
    expect(observedJobLinks(page, preferences, [])).toEqual([
      'https://careers.example.com/jobs/engineering-intern',
      'https://careers.example.com/jobs/123',
    ]);
    expect(
      observedJobLinks(page, preferences, ['https://careers.example.com/jobs/engineering-intern']),
    ).not.toContain('https://careers.example.com/jobs/engineering-intern');
  });
  it('bounds followups to two different employers before repeating one employer', () => {
    expect(
      selectFollowupUrls(
        [
          'https://jobs.smartrecruiters.com/One/123456789-intern',
          'https://jobs.smartrecruiters.com/One/123456790-intern',
          'https://jobs.smartrecruiters.com/Two/123456791-intern',
        ],
        [],
      ),
    ).toEqual([
      'https://jobs.smartrecruiters.com/One/123456789-intern',
      'https://jobs.smartrecruiters.com/Two/123456791-intern',
    ]);
  });
  it('uses at most three short opportunity-specific queries with employer and ATS coverage', () => {
    const queries = discoveryQueries(preferences);
    expect(queries).toHaveLength(3);
    expect(queries[0].query).toBe('Engineering "United Arab Emirates" internship');
    expect(queries[0].options.excludeDomains).toContain('indeed.com');
    expect(queries[1].options.includeDomains).toContain('smartrecruiters.com');
    expect(queries[1].query).not.toContain('greenhouse OR lever');
    expect(queries[2].query).toBe('Engineering UAE "entry level" jobs');
  });
  it('gives observed employer/ATS pages the four reads before generic aggregators', () => {
    const hits = [
      'https://ae.indeed.com/q-fresh-engineering-graduates-jobs.html',
      'https://www.bayt.com/en/international/jobs/fresh-graduate-engineer-jobs/',
      'https://jobs.smartrecruiters.com/EmployerOne/744000152212175-engineering-intern',
      'https://jobs.smartrecruiters.com/EmployerTwo/744000152212176-graduate-engineer',
      'https://jobs.lever.co/employer-three/12345678-abcd-1234-abcd-123456789abc',
      'https://www.employer-four.com/careers/',
    ].map((url) => ({
      url,
      title: 'Graduate Engineering Intern',
      snippet: 'Engineering internships in the United Arab Emirates.',
    }));
    const selected = selectSourceUrls(hits, preferences);
    expect(selected).toHaveLength(4);
    expect(selected.every((url) => !/indeed|bayt/.test(url))).toBe(true);
    expect(selected.filter((url) => url.includes('smartrecruiters'))).toHaveLength(2);
    expect(selected).toContain('https://www.employer-four.com/careers/');
  });
  it('rejects senior London ATS details instead of ranking their domain over Dubai relevance', () => {
    const finance = { ...preferences, role: 'Finance', location: 'Dubai' };
    const wrong = {
      url: 'https://lseg.wd3.myworkdayjobs.com/Careers/job/London-United-Kingdom/Senior-Finance-Manager_R123',
      title: 'Senior Finance Manager - London',
      snippet: 'Finance roles and opportunities across Dubai and London.',
    };
    expect(sourceRelevance(wrong, finance)).toBeNull();
    const relevant = {
      url: 'https://careers.example.com/jobs/finance-intern-dubai',
      title: 'Finance Intern',
      snippet: 'Dubai, United Arab Emirates. Graduate finance internship.',
    };
    expect(selectSourceUrls([wrong, relevant], finance)).toEqual([relevant.url]);
  });
  it('accepts a country-level title with explicit Dubai evidence but rejects a different named city', () => {
    const finance = { ...preferences, role: 'Finance', location: 'Dubai' };
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/finance-intern-uae',
          title: 'Finance Intern - UAE',
          snippet: 'Location: Dubai. Finance internship.',
        },
        finance,
      )?.located,
    ).toBe(true);
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/finance-intern-abu-dhabi-uae',
          title: 'Finance Intern - Abu Dhabi, UAE',
          snippet: 'Our offices include Dubai.',
        },
        finance,
      ),
    ).toBeNull();
  });
  it('rejects explicit wrong regions and unrelated functions even on an ATS', () => {
    expect(
      sourceRelevance(
        {
          url: 'https://gm.wd5.myworkdayjobs.com/Careers/job/Detroit/Data-Governance-Analyst_R123',
          title: 'Data Governance Analyst',
          snippet: 'United States. Data governance across our engineering teams.',
        },
        preferences,
      ),
    ).toBeNull();
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/engineering-intern-london',
          title: 'Engineering Intern - London',
          snippet: 'An internship in the United Kingdom.',
        },
        preferences,
      ),
    ).toBeNull();
  });
  it('does not fill four read slots with generic global student portals', () => {
    const hits = [
      {
        url: 'https://search-careers.gm.com/en/early-careers/',
        title: 'Early Career Professionals',
        snippet: 'Engineering internships and graduate programmes.',
      },
      {
        url: 'https://careers.example.com/students/',
        title: 'Global student careers',
        snippet: 'Finance, engineering, sales and technology careers worldwide.',
      },
    ];
    expect(selectSourceUrls(hits, preferences)).toEqual([]);
  });
  it('uses hit snippets for a generic early-career title while keeping unknown-region reads bounded', () => {
    const relevant = {
      url: 'https://careers.employer.example/jobs/intern-and-entry-level-graduate',
      title: 'Intern & Entry Level Graduate',
      snippet: 'Engineering/Science/Technology. United Arab Emirates.',
    };
    expect(sourceRelevance(relevant, preferences)?.located).toBe(true);
    const unknowns = ['one', 'two', 'three'].map((company) => ({
      url: `https://${company}.example/jobs/engineering-intern`,
      title: 'Engineering Intern',
      snippet: 'Early-career engineering opportunity.',
    }));
    expect(selectSourceUrls([relevant, ...unknowns], preferences)).toHaveLength(2);
  });
  it('matches finance/financial and requires all meaningful words of a compound role', () => {
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/financial-intern-dubai',
          title: 'Financial Planning Intern',
          snippet: 'Dubai internship.',
        },
        { ...preferences, role: 'Finance', location: 'Dubai' },
      ),
    ).not.toBeNull();
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/data-governance-intern-uae',
          title: 'Data Governance Intern',
          snippet: 'United Arab Emirates internship.',
        },
        { ...preferences, role: 'Data engineer' },
      ),
    ).toBeNull();
  });
  it('supports short role acronyms without matching country-name prefixes', () => {
    const qa = { ...preferences, role: 'QA', location: 'Dubai' };
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/qa-intern-dubai',
          title: 'QA Intern',
          snippet: 'Dubai quality assurance internship.',
        },
        qa,
      ),
    ).not.toBeNull();
    expect(
      sourceRelevance(
        {
          url: 'https://careers.example.com/jobs/finance-intern-dubai',
          title: 'Finance Intern',
          snippet: 'Dubai office. Work with our Qatar team.',
        },
        qa,
      ),
    ).toBeNull();
  });
  it('does not follow observed junior job links in a clearly different location', () => {
    expect(
      observedJobLinks(
        {
          url: 'https://careers.example.com/',
          text: '[Graduate Finance Analyst - London](https://careers.example.com/jobs/finance-graduate-london)',
        },
        { ...preferences, role: 'Finance', location: 'Dubai' },
        [],
      ),
    ).toEqual([]);
  });
  it('chooses the readable employer portal over an explicitly blocked first result', () => {
    const selected = selectAgentSource([
      {
        url: 'https://ae.indeed.com/jobs',
        readable: false,
        blocked: true,
        closed: false,
        incomplete: true,
      },
      {
        url: 'https://www.emiratesgroupcareers.com/engineering/',
        readable: true,
        blocked: false,
        closed: false,
        incomplete: true,
      },
      {
        url: 'https://www.bayt.com/jobs',
        readable: false,
        blocked: true,
        closed: false,
        incomplete: true,
      },
    ]);
    expect(selected).toBe('https://www.emiratesgroupcareers.com/engineering/');
  });
  it('never uses Agent to work around an explicit login or CAPTCHA denial', () => {
    expect(
      selectAgentSource([
        {
          url: 'https://employer.example.com/careers',
          readable: false,
          blocked: true,
          closed: false,
          incomplete: true,
        },
      ]),
    ).toBeUndefined();
  });
  it('does not spend Agent budget on a closed or already-complete listing', () => {
    expect(
      selectAgentSource([
        {
          url: 'https://employer.example.com/jobs/1',
          readable: true,
          blocked: false,
          closed: true,
          incomplete: true,
        },
        {
          url: 'https://employer.example.com/jobs/2',
          readable: true,
          blocked: false,
          closed: false,
          incomplete: false,
        },
      ]),
    ).toBeUndefined();
  });
  it('recognizes the exact observed ADNOC filled-job message without job metadata', () => {
    expect(listingClosed("We're sorry… the job you are trying to apply for has been filled.")).toBe(
      true,
    );
    expect(listingClosed('We are hiring for this job. Apply now.')).toBe(false);
  });
});
