import { describe, expect, it } from 'vitest';
import {
  AGENT_USAGE_ACCOUNTING_BASIS,
  reportedAgentCostUsd,
  type ReportedAgentUsage,
} from '../server/agent-usage';

const NOW = Date.parse('2026-09-30T16:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (time: number) => new Date(time).toISOString();
const usage = (overrides: Partial<ReportedAgentUsage> = {}): ReportedAgentUsage => ({
  expectedRunId: 'run-accounted_123',
  observedRunId: 'run-accounted_123',
  status: 'COMPLETED',
  numOfSteps: 4,
  maxSteps: 20,
  rateUsd: '0.016',
  ratesVerifiedAt: iso(NOW - HOUR),
  ratesExpiresAt: iso(NOW + 5 * HOUR),
  ...overrides,
});

describe('owner-approved reported Agent usage accounting', () => {
  it('labels this policy as reported usage rather than final invoice evidence', () => {
    expect(AGENT_USAGE_ACCOUNTING_BASIS).toBe('reported-usage');
  });

  it.each([
    [4, 20, 0.064],
    [16, 20, 0.256],
    [20, 20, 0.32],
    [150, 150, 2.4],
  ])('accounts %s reported steps under a %s-step ticket', (steps, maxSteps, cost) => {
    expect(reportedAgentCostUsd(usage({ numOfSteps: steps, maxSteps }), NOW)).toBe(cost);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('accepts final %s usage', (status) => {
    expect(reportedAgentCostUsd(usage({ status }), NOW)).toBe(0.064);
  });

  it('returns numeric zero for a matching cancelled run that explicitly reports zero steps', () => {
    expect(reportedAgentCostUsd(usage({ status: 'CANCELLED', numOfSteps: 0 }), NOW)).toBe(0);
  });

  it('uses the verified rate rather than assuming the maximum contract rate', () => {
    expect(reportedAgentCostUsd(usage({ rateUsd: '0.012500000000' }), NOW)).toBe(0.05);
  });

  it('rounds fractional microdollars upward without binary floating-point undercounting', () => {
    expect(reportedAgentCostUsd(usage({ numOfSteps: 1, rateUsd: '0.000001000001' }), NOW)).toBe(
      0.000002,
    );
    expect(reportedAgentCostUsd(usage({ numOfSteps: 1, rateUsd: '0.000001000000' }), NOW)).toBe(
      0.000001,
    );
    expect(reportedAgentCostUsd(usage({ numOfSteps: 0, rateUsd: '0.000000000001' }), NOW)).toBe(0);
  });

  it.each([
    ['missing reported ID', { observedRunId: undefined }],
    ['different reported ID', { observedRunId: 'another-run' }],
    ['coerced reported ID', { observedRunId: 123 }],
    ['missing expected ID', { expectedRunId: undefined }],
    ['empty IDs', { expectedRunId: '', observedRunId: '' }],
    ['path-shaped IDs', { expectedRunId: '../run', observedRunId: '../run' }],
    ['long IDs', { expectedRunId: 'a'.repeat(201), observedRunId: 'a'.repeat(201) }],
    ['pending status', { status: 'PENDING' }],
    ['running status', { status: 'RUNNING' }],
    ['unknown status', { status: 'unknown' }],
    ['lowercase status', { status: 'completed' }],
    ['missing status', { status: undefined }],
    ['missing steps', { numOfSteps: undefined }],
    ['null steps', { numOfSteps: null }],
    ['string steps', { numOfSteps: '4' }],
    ['boolean steps', { numOfSteps: false }],
    ['negative steps', { numOfSteps: -1 }],
    ['fractional steps', { numOfSteps: 1.5 }],
    ['infinite steps', { numOfSteps: Infinity }],
    ['NaN steps', { numOfSteps: NaN }],
    ['unsafe steps', { numOfSteps: Number.MAX_SAFE_INTEGER + 1 }],
    ['bounded overflow', { numOfSteps: 21 }],
    ['legacy overflow', { numOfSteps: 151, maxSteps: 150 }],
    ['missing dispatch limit', { maxSteps: undefined }],
    ['string dispatch limit', { maxSteps: '20' }],
    ['unrecognized dispatch limit', { maxSteps: 500 }],
    ['missing rate', { rateUsd: undefined }],
    ['numeric rate', { rateUsd: 0.016 }],
    ['zero rate', { rateUsd: '0' }],
    ['negative rate', { rateUsd: '-0.016' }],
    ['higher rate', { rateUsd: '0.016000000001' }],
    ['exponential rate', { rateUsd: '1.6e-2' }],
    ['rate whitespace', { rateUsd: ' 0.016' }],
    ['too-precise rate', { rateUsd: '0.0160000000000' }],
    ['unbounded rate string', { rateUsd: '9'.repeat(500) }],
    ['null proof time', { ratesVerifiedAt: null }],
    ['invalid proof time', { ratesVerifiedAt: 'not a date' }],
    ['date-only proof time', { ratesVerifiedAt: '2026-09-30' }],
    ['future proof', { ratesVerifiedAt: iso(NOW + 1) }],
    [
      'stale manual proof',
      { ratesVerifiedAt: iso(NOW - 24 * HOUR - 1), ratesExpiresAt: undefined },
    ],
    ['null attestation expiry', { ratesExpiresAt: null }],
    ['invalid attestation expiry', { ratesExpiresAt: 'invalid' }],
    ['expired attestation', { ratesExpiresAt: iso(NOW) }],
    ['overlong attestation', { ratesExpiresAt: iso(NOW + 5 * HOUR + 1) }],
  ] satisfies [string, Partial<ReportedAgentUsage>][])('retains the hold for %s', (_, changes) => {
    expect(reportedAgentCostUsd(usage(changes), NOW)).toBeNull();
  });

  it('does not turn a cancellation acknowledgment without usage into zero cost', () => {
    expect(
      reportedAgentCostUsd(usage({ status: 'CANCELLED', numOfSteps: undefined }), NOW),
    ).toBeNull();
    expect(
      reportedAgentCostUsd(
        usage({ status: 'CANCELLED', observedRunId: undefined, numOfSteps: 0 }),
        NOW,
      ),
    ).toBeNull();
  });

  it('permits the already-supported manual proof only inside its explicit 24-hour window', () => {
    expect(
      reportedAgentCostUsd(
        usage({ ratesVerifiedAt: iso(NOW - 24 * HOUR), ratesExpiresAt: undefined }),
        NOW,
      ),
    ).toBe(0.064);
  });

  it('fails closed on an invalid runtime clock', () => {
    expect(reportedAgentCostUsd(usage(), NaN)).toBeNull();
    expect(reportedAgentCostUsd(usage(), Infinity)).toBeNull();
  });

  it('rejects dates and times that JavaScript would normalize into a different instant', () => {
    const october = Date.parse('2026-10-01T01:00:00Z');
    expect(
      reportedAgentCostUsd(
        usage({ ratesVerifiedAt: '2026-09-31T00:00:00Z', ratesExpiresAt: undefined }),
        october,
      ),
    ).toBeNull();
    expect(
      reportedAgentCostUsd(
        usage({ ratesVerifiedAt: '2026-09-30T24:00:00Z', ratesExpiresAt: undefined }),
        october,
      ),
    ).toBeNull();
  });
});
