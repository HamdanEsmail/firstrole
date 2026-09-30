import type { Database } from './db';

export type EnrichmentProvider = 'openrouter' | 'firecrawl';
export interface EnrichmentAdmission {
  provider: EnrichmentProvider;
  operationKey: string;
  keyFingerprint: string;
  maxCostUsd?: number;
  units?: 1;
  model?: string;
  inputBytes?: number;
  maxOutputTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  ratesVerifiedAt?: string;
}
export interface EnrichmentTicket {
  operationId: string;
  claimToken: string;
  provider: EnrichmentProvider;
}
export interface EnrichmentSettlement {
  outcome: 'completed' | 'failed' | 'cancelled' | 'not-started' | 'unknown';
  actualCostUsd?: number;
  actualUnits?: number;
  authoritative: boolean;
  providerRequestId?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface EnrichmentMeter {
  admit(options: EnrichmentAdmission): Promise<EnrichmentTicket | null>;
  settle(
    ticket: EnrichmentTicket,
    settlement: EnrichmentSettlement,
  ): Promise<void | EnrichmentSettlementResult>;
}
export interface EnrichmentSettlementResult {
  settled: boolean;
  state: 'settled' | 'needs_reconciliation' | 'unconfirmed';
  outcome: EnrichmentSettlement['outcome'];
  providerDisabled?: boolean;
}

export const ENRICHMENT_MODEL = 'google/gemma-4-26b-a4b-it';
export const OPENROUTER_RESERVATION_USD = 0.01;
export const MAX_ENRICHMENT_INPUT_BYTES = 64000;
export const MAX_ENRICHMENT_OUTPUT_TOKENS = 1800;

function admissible(options: EnrichmentAdmission): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(options.keyFingerprint) ||
    !options.operationKey ||
    options.operationKey.length > 256 ||
    (options.units !== undefined && options.units !== 1)
  )
    return false;
  if (options.provider === 'firecrawl')
    return options.maxCostUsd === undefined || options.maxCostUsd === 0;
  if (options.provider !== 'openrouter' || options.model !== ENRICHMENT_MODEL) return false;
  if (options.maxCostUsd !== undefined && options.maxCostUsd !== OPENROUTER_RESERVATION_USD)
    return false;
  if (
    !Number.isInteger(options.inputBytes) ||
    options.inputBytes! < 1 ||
    options.inputBytes! > MAX_ENRICHMENT_INPUT_BYTES ||
    !Number.isInteger(options.maxOutputTokens) ||
    options.maxOutputTokens! < 1 ||
    options.maxOutputTokens! > MAX_ENRICHMENT_OUTPUT_TOKENS
  )
    return false;
  if (
    !Number.isFinite(options.inputPricePerMillion) ||
    options.inputPricePerMillion! < 0 ||
    options.inputPricePerMillion! > 0.1 ||
    !Number.isFinite(options.outputPricePerMillion) ||
    options.outputPricePerMillion! < 0 ||
    options.outputPricePerMillion! > 0.4
  )
    return false;
  const verified = Date.parse(options.ratesVerifiedAt ?? '');
  const age = Date.now() - verified;
  return (
    Number.isFinite(verified) &&
    age >= -60000 &&
    age < 24 * 60 * 60 * 1000 &&
    (options.inputBytes! * options.inputPricePerMillion! +
      options.maxOutputTokens! * options.outputPricePerMillion!) /
      1_000_000 <=
      OPENROUTER_RESERVATION_USD
  );
}

/** Optional readers use this meter; denial/storage failure never starts a provider call. */
export class EnrichmentBudget implements EnrichmentMeter {
  constructor(
    private readonly db: Pick<Database, 'rpc'>,
    private readonly searchId: string,
  ) {}

  async admit(options: EnrichmentAdmission): Promise<EnrichmentTicket | null> {
    if (!admissible(options)) return null;
    const claimToken = crypto.randomUUID();
    try {
      const admitted = await this.db.rpc<{ admitted: boolean; operationId?: string }>(
        'admit_enrichment_operation',
        {
          p_run_id: this.searchId,
          p_provider: options.provider,
          p_operation_key: options.operationKey,
          p_key_fingerprint: options.keyFingerprint,
          p_claim_token: claimToken,
          p_model: options.model ?? null,
          p_input_bytes: options.inputBytes ?? null,
          p_output_tokens: options.maxOutputTokens ?? null,
          p_input_price: options.inputPricePerMillion ?? null,
          p_output_price: options.outputPricePerMillion ?? null,
          p_rates_verified_at: options.ratesVerifiedAt ?? null,
        },
      );
      if (!admitted?.admitted || !admitted.operationId) return null;
      return { operationId: admitted.operationId, claimToken, provider: options.provider };
    } catch {
      return null;
    }
  }

  async settle(
    ticket: EnrichmentTicket,
    settlement: EnrichmentSettlement,
  ): Promise<EnrichmentSettlementResult> {
    try {
      const result = await this.db.rpc<{
        settled: boolean;
        state?: string;
        providerDisabled?: boolean;
      }>('settle_enrichment_operation', {
        p_operation_id: ticket.operationId,
        p_claim_token: ticket.claimToken,
        p_outcome: settlement.outcome,
        p_actual_usd: settlement.actualCostUsd ?? null,
        p_actual_units: settlement.actualUnits ?? null,
        p_authoritative: settlement.authoritative === true,
        p_provider_request_id: settlement.providerRequestId ?? null,
      });
      return {
        settled: result?.settled === true,
        state: result?.settled ? 'settled' : 'needs_reconciliation',
        outcome: settlement.outcome,
        providerDisabled: result?.providerDisabled === true,
      };
    } catch {
      return { settled: false, state: 'unconfirmed', outcome: settlement.outcome };
    }
  }
}
