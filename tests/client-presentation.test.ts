import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sourceLabel } from '../src/lib/source-label';
import { clearRecoveredPollingError, type PollingError } from '../src/lib/polling-error';
import { matchReasonTone } from '../src/lib/match-reason';
import { JobDetail, JobRow } from '../src/components/Jobs';
import type { Job } from '../shared/types';

describe('source labels stay text', () => {
  it('shows common encoded employer and role characters as readable text', () => {
    expect(sourceLabel('R&amp;D &quot;Graduate&quot; &#39;27 &apos;role&apos;&nbsp;')).toBe(
      `R&D "Graduate" '27 'role' `,
    );
    const html = renderToStaticMarkup(createElement('span', null, sourceLabel('R&amp;D')));
    expect(html).toBe('<span>R&amp;D</span>');
    expect(html).not.toContain('&amp;amp;');
  });

  it('keeps decoded markup escaped at the React text boundary', () => {
    const label = sourceLabel('&lt;img src=x onerror=alert(1)&gt;');
    const html = renderToStaticMarkup(createElement('span', null, label));
    expect(label).toBe('<img src=x onerror=alert(1)>');
    expect(html).toBe('<span>&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).not.toContain('<img');
  });

  it('preserves unknown entities and only decodes one source encoding layer', () => {
    expect(sourceLabel('AT&T · &unknown; · &amp;lt;')).toBe('AT&T · &unknown; · &lt;');
    expect(sourceLabel('مطور برمجيات — C++')).toBe('مطور برمجيات — C++');
  });
});

describe('polling error recovery', () => {
  const failure: PollingError = {
    scope: 'account-a:1',
    runId: 'run-a',
    message: 'Search temporarily unavailable',
  };

  it('clears the recorded message after a successful poll for the same owner and run', () => {
    // App retains this record in a ref while offline/token changes restart its effect.
    expect(
      clearRecoveredPollingError(failure.message, failure, failure.scope, failure.runId),
    ).toBeNull();
  });

  it('preserves another operation error or an already-dismissed message', () => {
    expect(
      clearRecoveredPollingError(
        'Could not refresh the listing',
        failure,
        failure.scope,
        failure.runId,
      ),
    ).toBe('Could not refresh the listing');
    expect(clearRecoveredPollingError(null, failure, failure.scope, failure.runId)).toBeNull();
  });

  it('does not clear an identically worded error belonging to another owner or search', () => {
    expect(clearRecoveredPollingError(failure.message, failure, 'account-b:2', failure.runId)).toBe(
      failure.message,
    );
    expect(clearRecoveredPollingError(failure.message, failure, failure.scope, 'run-b')).toBe(
      failure.message,
    );
    expect(clearRecoveredPollingError(failure.message, null, failure.scope, failure.runId)).toBe(
      failure.message,
    );
  });
});

describe('match evidence presentation', () => {
  it.each([
    ['Opening status needs checking', 'caution'],
    ['Sponsorship eligibility needs checking', 'caution'],
    ['Remote eligibility needs checking', 'caution'],
    ['Latest check could not confirm availability', 'caution'],
    ['Sponsorship not available', 'caution'],
    ['Posting date not stated', 'neutral'],
    ['Work arrangement not stated', 'neutral'],
    ['Listing location: London', 'neutral'],
    ['A new reason with no positive classification', 'neutral'],
    ['Title includes data, analyst', 'positive'],
    ['Location matches Dubai', 'positive'],
    ['Sponsorship explicitly mentioned', 'positive'],
  ])('presents %s as %s evidence', (reason, tone) => {
    expect(matchReasonTone(reason)).toBe(tone);
  });

  it('retains availability caveats with caution icons in both rows and details', () => {
    const job: Job = {
      id: 'presentation-fixture',
      title: 'Data Analyst',
      company: 'Example',
      location: 'Dubai',
      workplace: 'onsite',
      remoteRegion: null,
      employmentType: 'entry-level',
      sourceUrl: 'https://careers.example.com/jobs/123',
      applyUrl: 'https://careers.example.com/jobs/123/apply',
      requisitionId: null,
      description: 'Test-only presentation fixture.',
      requirements: [],
      salary: null,
      postedAt: null,
      deadline: null,
      checkedAt: '2026-09-30T10:00:00Z',
      sponsorship: 'not-stated',
      evidence: [],
      availability: 'unverified',
      match: {
        tier: 'Possible match',
        score: 54,
        reasons: ['Opening status needs checking', 'Title includes data'],
      },
    };
    const noop = () => {};
    const row = renderToStaticMarkup(
      createElement(JobRow, {
        job,
        selected: false,
        saved: false,
        compared: false,
        onSelect: noop,
        onSave: noop,
        onCompare: noop,
      }),
    );
    const detail = renderToStaticMarkup(
      createElement(JobDetail, {
        job,
        saved: false,
        refreshing: false,
        onSave: noop,
        onClose: noop,
        onRefresh: noop,
      }),
    );
    for (const html of [row, detail]) {
      const start = html.indexOf('<li class="reason-caution">');
      expect(start).toBeGreaterThan(-1);
      const warning = html.slice(start, html.indexOf('</li>', start));
      expect(warning).toContain('Opening status needs checking');
      expect(warning).not.toContain('lucide-check');
      expect(html).toContain('reason-positive');
      expect(html).toContain('Title includes data');
    }
    expect(detail).toContain('reason-icon reason-caution');
    expect(detail).toContain('We could not confirm this listing');
  });
});
