import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { initialPage, workspaceEntry } from '../src/lib/navigation';
import {
  importantRequirements,
  payLabel,
  availabilityLabel,
  postingDateLabel,
} from '../src/lib/job-brief';
import LandingPage from '../src/components/LandingPage';
import type { Job } from '../shared/types';

describe('landing and workspace entry', () => {
  it('keeps public landing, workspace, and privacy as separate pages', () => {
    expect(initialPage({ pathname: '/', search: '', hash: '' })).toEqual({ page: 'landing' });
    expect(initialPage({ pathname: '/app/', search: '', hash: '' })).toEqual({ page: 'workspace' });
    expect(initialPage({ pathname: '/privacy', search: '', hash: '' })).toEqual({
      page: 'privacy',
    });
    expect(
      initialPage({ pathname: '/', search: '?utm_source=test', hash: '#how-it-works' }),
    ).toEqual({ page: 'landing' });
  });
  it('preserves every OAuth callback parameter while entering the same-origin workspace', () => {
    expect(
      initialPage({
        pathname: '/',
        search: '?code=synthetic-code&state=synthetic-state',
        hash: '#preserved',
      }),
    ).toEqual({
      page: 'workspace',
      replacePath: '/app?code=synthetic-code&state=synthetic-state#preserved',
    });
    expect(
      initialPage({
        pathname: '/',
        search: '',
        hash: '#access_token=synthetic&refresh_token=synthetic',
      }),
    ).toEqual({
      page: 'workspace',
      replacePath: '/app#access_token=synthetic&refresh_token=synthetic',
    });
    expect(
      initialPage({
        pathname: '/',
        search: '?error=access_denied&error_description=cancelled',
        hash: '',
      }).page,
    ).toBe('workspace');
  });
  it('does not turn a callback query into an external redirect', () => {
    const result = initialPage({
      pathname: '/',
      search: '?code=synthetic&next=https://untrusted.example',
      hash: '',
    });
    expect(new URL(result.replacePath!, 'https://firstrole.example').origin).toBe(
      'https://firstrole.example',
    );
    expect(new URL(result.replacePath!, 'https://firstrole.example').pathname).toBe('/app');
  });
  it('supports intentional workspace links without allowing arbitrary view names', () => {
    expect(workspaceEntry('?view=saved')).toEqual({ view: 'saved', signIn: false });
    expect(workspaceEntry('?view=applications&signin=1')).toEqual({
      view: 'applications',
      signIn: true,
    });
    expect(workspaceEntry('?view=untrusted&signin=no')).toEqual({ view: 'find', signIn: false });
  });
  it('renders an explanatory landing brief with working routes, not fictional listings', () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(html).toContain('Make your');
    expect(html).toContain('What your opportunity brief includes');
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/app?signin=1"');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain('Strong match');
    expect(html).not.toContain('job-row');
    expect(html).not.toContain('mailto:');
  });
});

describe('source-grounded opportunity brief', () => {
  it('prioritizes explicit constraints while keeping the exact source wording', () => {
    const requirements = [
      'Preferred: French language.',
      'Clear communication.',
      'UAE Nationals with Family Book Only.',
      'Bachelor degree required; a master degree is preferred.',
      'Two years experience.',
    ];
    const job = { requirements } as Job;
    expect(importantRequirements(job)).toEqual([requirements[2], requirements[3], requirements[4]]);
    expect(job.requirements).toEqual(requirements);
  });
  it('deduplicates excerpts and never invents eligibility facts from missing requirements', () => {
    expect(importantRequirements({ requirements: [] } as unknown as Job)).toEqual([]);
    expect(
      importantRequirements({
        requirements: ['SQL experience', ' SQL experience ', 'Source requirement'],
      } as Job),
    ).toEqual(['SQL experience', 'Source requirement']);
  });
  it('preserves pay units and distinguishes unknown pay from unpaid work', () => {
    expect(
      payLabel({ salary: { text: 'GBP 20–25 per hour', currency: 'GBP', period: 'hour' } } as Job),
    ).toBe('GBP 20–25 per hour');
    expect(payLabel({ salary: null } as Job)).toBe('Pay not listed');
    expect(availabilityLabel({ availability: 'unverified' } as Job)).toBe('Could not verify');
    expect(availabilityLabel({ availability: 'open' } as Job)).toBe('Open on source');
  });
  it('keeps a source calendar deadline on the correct day in a western timezone', () => {
    const format = Date.prototype.toLocaleDateString;
    const spy = vi
      .spyOn(Date.prototype, 'toLocaleDateString')
      .mockImplementation(function (this: Date, locales, options) {
        return format.call(this, 'en-GB', {
          ...options,
          timeZone: options?.timeZone || 'America/Los_Angeles',
        });
      });
    try {
      expect(postingDateLabel('2026-09-30')).toBe('30/09/2026');
      expect(postingDateLabel(null)).toBe('Not stated');
    } finally {
      spy.mockRestore();
    }
  });
});
