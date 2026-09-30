import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../server/db';
import {
  EnrichmentBudget,
  ENRICHMENT_MODEL,
  type EnrichmentAdmission,
  type EnrichmentTicket,
} from '../server/enrichment-budget';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const key = 'a'.repeat(64);
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function valid(overrides: Partial<EnrichmentAdmission> = {}): EnrichmentAdmission {
  return {
    provider: 'openrouter',
    operationKey: 'job-one-attempt-one',
    keyFingerprint: key,
    model: ENRICHMENT_MODEL,
    maxCostUsd: 0.01,
    units: 1,
    inputBytes: 63096,
    maxOutputTokens: 1800,
    inputPricePerMillion: 0.06,
    outputPricePerMillion: 0.2,
    ratesVerifiedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const rpc = vi.fn().mockResolvedValue({ admitted: true, operationId });
  return { rpc, meter: new EnrichmentBudget({ rpc } as unknown as Pick<Database, 'rpc'>, runId) };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('optional enrichment admission', () => {
  it('obtains reservation and one dispatch claim in one service RPC', async () => {
    const { rpc, meter } = setup();
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const ticket = await meter.admit(valid());
    expect(ticket).toEqual({ operationId, provider: 'openrouter', claimToken: expect.any(String) });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      'admit_enrichment_operation',
      expect.objectContaining({
        p_run_id: runId,
        p_provider: 'openrouter',
        p_operation_key: 'job-one-attempt-one',
        p_key_fingerprint: key,
        p_model: ENRICHMENT_MODEL,
        p_input_bytes: 63096,
        p_output_tokens: 1800,
        p_input_price: 0.06,
        p_output_price: 0.2,
      }),
    );
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each([
    ['rotated/missing key proof', { keyFingerprint: '' }],
    ['wrong model', { model: 'other/model' }],
    ['understated reservation', { maxCostUsd: 0.001 }],
    ['too much input', { inputBytes: 64001 }],
    ['too much output', { maxOutputTokens: 1801 }],
    ['fractional token bound', { maxOutputTokens: 1.5 }],
    ['expensive prompt', { inputPricePerMillion: 0.101 }],
    ['expensive completion', { outputPricePerMillion: 0.401 }],
    ['invalid price', { inputPricePerMillion: NaN }],
    ['stale rate proof', { ratesVerifiedAt: new Date(NOW - 86400001).toISOString() }],
    ['future rate proof', { ratesVerifiedAt: new Date(NOW + 60001).toISOString() }],
    ['missing output limit', { maxOutputTokens: undefined }],
  ] as [string, Partial<EnrichmentAdmission>][])(
    'skips %s before any database/provider operation',
    async (_name, change) => {
      const { rpc, meter } = setup();
      expect(await meter.admit(valid(change))).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it('uses a one-credit, zero-dollar Firecrawl admission', async () => {
    const { rpc, meter } = setup();
    expect(
      await meter.admit({
        provider: 'firecrawl',
        operationKey: 'read-one',
        keyFingerprint: key,
        units: 1,
        maxCostUsd: 0,
      }),
    ).not.toBeNull();
    expect(rpc).toHaveBeenCalledWith(
      'admit_enrichment_operation',
      expect.objectContaining({ p_provider: 'firecrawl', p_model: null }),
    );
    expect(
      await meter.admit({
        provider: 'firecrawl',
        operationKey: 'paid-read',
        keyFingerprint: key,
        maxCostUsd: 0.01,
      }),
    ).toBeNull();
  });
  it('denied or replayed admission never returns a dispatch ticket', async () => {
    const { rpc, meter } = setup();
    rpc.mockResolvedValue({ admitted: false, reused: true, operationId, state: 'claimed' });
    expect(await meter.admit(valid())).toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('a lost admission response is never automatically retried', async () => {
    const { rpc, meter } = setup();
    rpc.mockRejectedValue(new Error('connection lost after commit'));
    expect(await meter.admit(valid())).toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
  });
});

describe('optional enrichment reconciliation', () => {
  const ticket: EnrichmentTicket = {
    operationId,
    claimToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    provider: 'openrouter',
  };
  it('keeps accounting and provider completion distinct when usage is missing', async () => {
    const { rpc, meter } = setup();
    rpc.mockResolvedValue({ settled: false, state: 'needs_reconciliation' });
    expect(
      await meter.settle(ticket, {
        outcome: 'completed',
        authoritative: false,
        providerRequestId: 'generation-one',
      }),
    ).toEqual({
      settled: false,
      state: 'needs_reconciliation',
      outcome: 'completed',
      providerDisabled: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      'settle_enrichment_operation',
      expect.objectContaining({
        p_actual_usd: null,
        p_authoritative: false,
        p_provider_request_id: 'generation-one',
      }),
    );
  });
  it('passes only confirmed cost, never estimates from token usage', async () => {
    const { rpc, meter } = setup();
    rpc.mockResolvedValue({ settled: true });
    await meter.settle(ticket, {
      outcome: 'completed',
      authoritative: true,
      actualCostUsd: 0.000321123456,
      usage: { inputTokens: 500, outputTokens: 600 },
      providerRequestId: 'generation-one',
    });
    expect(rpc).toHaveBeenCalledWith(
      'settle_enrichment_operation',
      expect.objectContaining({ p_actual_usd: 0.000321123456, p_authoritative: true }),
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('inputTokens');
  });
  it('storage failure preserves a usable optional-provider outcome without pretending billing settled', async () => {
    const { rpc, meter } = setup();
    rpc.mockRejectedValue(new Error('storage failed'));
    expect(
      await meter.settle(ticket, {
        outcome: 'completed',
        authoritative: true,
        actualCostUsd: 0.0003,
      }),
    ).toEqual({ settled: false, state: 'unconfirmed', outcome: 'completed' });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('surfaces a confirmed billing overrun disabling only the optional provider', async () => {
    const { rpc, meter } = setup();
    rpc.mockResolvedValue({ settled: true, providerDisabled: true });
    expect(
      await meter.settle(ticket, {
        outcome: 'completed',
        authoritative: true,
        actualCostUsd: 0.02,
      }),
    ).toMatchObject({ settled: true, providerDisabled: true });
  });
});
