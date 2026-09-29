import { describe, expect, it } from 'vitest';
import { extractRoleContent, sourceCompanyCase } from '../server/content';
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

describe('source-only role content', () => {
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
});
