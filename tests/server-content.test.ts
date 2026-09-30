import { describe, expect, it } from 'vitest';
import {
  extractCompensation,
  extractRoleContent,
  sourceCompanyCase,
  sourceConfirmsClaim,
} from '../server/content';
import { verifyJob } from '../server/quality';
import type { Job, SearchPreferences } from '../shared/types';

const source = `Skip to main content
**Welcome!**
Intel Corporation uses cookies and similar technologies.
## Software Engineering - Intern, Graduate
**locations**: US, Oregon, Hillsboro
**job requisition id**: JR0286836
## Job Description:
At Intel, you will work on technology.
**What You'll Do**
Build technologies that power the future of computing.
* Design, develop, test, and improve software.
* Collaborate with hardware and software teams.
**Where Your Career Could Take You**
* AI Frameworks Engineer
## **Qualifications:**
Must possess the minimum qualifications below to be initially considered.
**Minimum Qualifications**
* Currently pursuing a Master's degree or PhD in Computer Science.
* Experience with Python or C++.
**Preferred Qualifications**
* Familiarity with Linux.
## Benefits
Read our Cookie Notice.
Apply`;

const flattenedPosting = `# Civil Engineering Intern
### Job description
Legal Entity: Example Inc Business Line: Engineering Compensation: USD 16.25 - USD 22.33 - hourly Company Description Employer background.
We are the world's trusted infrastructure consulting firm.
#### Job Description
Build roads and prepare drawings. Qualifications Candidates must be pursuing an engineering degree and must have completed at least one year of study.
Valid U.S. Driver's License required for site visits. As a condition of employment, selected candidate must pass a Motor Vehicle Records review.
#### Preferred Qualifications
Proficient with BIM. Experience with SQL.
#### Additional Information
Apply now`;

describe('source-only role content', () => {
  it('reads the deeper role section and flattened minimum qualifications instead of wrapper metadata', () => {
    const result = extractRoleContent(flattenedPosting);
    expect(result.description).toBe('Build roads and prepare drawings.');
    expect(result.requirements.some((item) => item.includes('engineering degree'))).toBe(true);
    expect(
      result.requirements.some((item) => item.includes("U.S. Driver's License required")),
    ).toBe(true);
    expect(result.requirements.some((item) => item.includes('Motor Vehicle Records'))).toBe(true);
    expect(result.requirements).toContain('Preferred: Proficient with BIM.');
    expect(result.requirements).toContain('Preferred: Experience with SQL.');
    expect(result.description).not.toMatch(/Legal Entity|Company Description|Compensation/);
  });
  it('extracts explicit compensation faithfully without inferring a currency from location', () => {
    expect(extractCompensation(flattenedPosting)).toMatchObject({
      text: 'USD 16.25 - USD 22.33 - hourly',
      currency: 'USD',
      period: 'hourly',
    });
    expect(extractCompensation('Salary: $20 - $25 hourly')).toMatchObject({
      currency: null,
      period: 'hourly',
    });
    expect(extractCompensation('Company revenue was USD 20 billion.')).toBeNull();
    expect(extractCompensation('Compensation: Competitive.')).toBeNull();
  });
  it('does not confirm opposite or stale source claims', () => {
    expect(sourceConfirmsClaim('Degree is required', 'No degree is required.')).toBe(false);
    expect(
      sourceConfirmsClaim('Ten years of experience', 'One year of experience is needed.'),
    ).toBe(false);
  });
  it('prefers actual work over navigation, cookies and generic employer promotion', () => {
    const result = extractRoleContent(source);
    expect(result.description).toBe(
      'Build technologies that power the future of computing. Design, develop, test, and improve software. Collaborate with hardware and software teams.',
    );
    expect(result.description).not.toMatch(/cookies|Welcome|Qualifications|\*|#/);
  });
  it('extracts only qualification requirements and labels preferred items', () => {
    expect(extractRoleContent(source).requirements).toEqual([
      "Currently pursuing a Master's degree or PhD in Computer Science.",
      'Experience with Python or C++.',
      'Preferred: Familiarity with Linux.',
    ]);
  });
  it('does not relabel responsibilities or generic bullets as requirements', () => {
    expect(
      extractRoleContent(
        '## Job Description\nBuild useful software.\n* Design APIs.\n* Collaborate with the team.',
      ).requirements,
    ).toEqual([]);
  });
  it('retains empty unknown sections instead of using unrelated navigation', () => {
    expect(
      extractRoleContent('Skip to main content\nWe use cookies.\n* Search jobs\n* Apply'),
    ).toEqual({ description: '', requirements: [] });
  });
  it('caps descriptions at a sentence boundary', () => {
    const description = extractRoleContent(
      `## About the role\n${'Develop reliable software with the team and review the results. '.repeat(40)}`,
    ).description;
    expect(description.length).toBeLessThanOrEqual(950);
    expect(description.endsWith('results.')).toBe(true);
  });
  it('uses observed brand case without inventing a missing brand spelling', () => {
    expect(sourceCompanyCase('intel', source)).toBe('Intel');
    expect(sourceCompanyCase('unseenbrand', source)).toBe('unseenbrand');
  });
  it('refreshes an existing cached job with clean source content', () => {
    const url = 'https://intel.wd1.myworkdayjobs.com/en-US/External/job/software-intern_JR0286836';
    const job: Job = {
      id: 'a'.repeat(64),
      title: 'Software Engineering - Intern, Graduate',
      company: 'intel',
      location: 'US, Oregon, Hillsboro',
      workplace: 'unknown',
      remoteRegion: null,
      employmentType: 'internship',
      sourceUrl: url,
      applyUrl: url,
      requisitionId: 'JR0286836',
      description: 'Skip to main content. Cookie Notice. **Job Details**',
      requirements: ['Design, develop, test, and improve software.'],
      salary: null,
      postedAt: null,
      deadline: null,
      checkedAt: '2026-09-29T10:00:00Z',
      sponsorship: 'not-stated',
      evidence: [{ field: 'listing', text: 'Cookie Notice.', sourceUrl: url }],
      availability: 'open',
      match: { score: 0, tier: 'Possible match', reasons: [] },
    };
    const preferences: SearchPreferences = {
      role: 'Software engineer',
      location: 'United States',
      jobTypes: ['internship'],
      workplaces: [],
      keywords: '',
      postedWithinDays: null,
      sponsorshipRequired: false,
    };
    const updated = verifyJob(job, { url, text: source }, preferences);
    expect(updated.company).toBe('Intel');
    expect(updated.description).toBe(extractRoleContent(source).description);
    expect(updated.requirements).toEqual(extractRoleContent(source).requirements);
    expect(updated.evidence.some((evidence) => evidence.text.includes('Cookie Notice'))).toBe(
      false,
    );
  });
  it('retains confirmed Agent claims while replacing stale salary and dropping unsupported claims', () => {
    const url = 'https://careers.example.com/jobs/civil-engineering-intern';
    const job: Job = {
      id: 'b'.repeat(64),
      title: 'Civil Engineering Intern',
      company: 'Example',
      location: 'United States',
      workplace: 'unknown',
      remoteRegion: null,
      employmentType: 'internship',
      sourceUrl: url,
      applyUrl: url,
      requisitionId: null,
      description: 'Build roads and prepare drawings. Launch nuclear rockets.',
      requirements: ['Completion of at least one year of study', 'Ten years of experience'],
      salary: { text: 'USD 99 - USD 100 hourly', currency: 'USD', period: 'hourly' },
      postedAt: null,
      deadline: null,
      checkedAt: '2026-09-29T10:00:00Z',
      sponsorship: 'not-stated',
      evidence: [],
      availability: 'unverified',
      match: { score: 0, tier: 'Possible match', reasons: [] },
    };
    const preferences: SearchPreferences = {
      role: 'Civil engineering',
      location: 'United States',
      jobTypes: ['internship'],
      workplaces: [],
      keywords: '',
      postedWithinDays: null,
      sponsorshipRequired: false,
    };
    const updated = verifyJob(job, { url, text: flattenedPosting }, preferences);
    expect(updated.description).toBe('Build roads and prepare drawings.');
    expect(updated.requirements).toContain('Completion of at least one year of study');
    expect(updated.requirements).not.toContain('Ten years of experience');
    expect(updated.salary).toEqual({
      text: 'USD 16.25 - USD 22.33 - hourly',
      currency: 'USD',
      period: 'hourly',
    });
    expect(
      updated.evidence.some((item) => item.field === 'salary' && item.text.includes('16.25')),
    ).toBe(true);

    const legacyEmployerIntro = verifyJob(
      {
        ...job,
        description: "Employer background. We are the world's trusted infrastructure consulting firm.",
      },
      { url, text: flattenedPosting },
      preferences,
    );
    expect(legacyEmployerIntro.description).toBe('Build roads and prepare drawings.');
    expect(legacyEmployerIntro.description).not.toContain('consulting firm');
  });
});
