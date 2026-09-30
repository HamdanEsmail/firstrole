import { AGENT_MAX_STEPS, LEGACY_AGENT_MAX_STEPS } from './agent-limits';
export const AGENT_USAGE_ACCOUNTING_BASIS = 'reported-usage' as const;

const HOUR_MS = 60 * 60 * 1000;
const DECIMAL_SCALE = 1_000_000_000_000n;
const MAX_STEP_RATE_SCALED = 16_000_000_000n;
const SCALED_UNITS_PER_MICRODOLLAR = 1_000_000n;

/** Untrusted provider observations must be checked against a server-owned ticket and rate proof. */
export interface ReportedAgentUsage {
  expectedRunId: unknown;
  observedRunId: unknown;
  status: unknown;
  numOfSteps: unknown;
  maxSteps: unknown;
  rateUsd: unknown;
  ratesVerifiedAt: unknown;
  ratesExpiresAt?: unknown;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() + 1 !== Number(month) ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scaledRate(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) return null;
  // Bound the string before integer parsing; rates above the cap cannot be admitted.
  if (value.length > 14) return null;
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(12, '0'));
  return scaled > 0n && scaled <= MAX_STEP_RATE_SCALED ? scaled : null;
}

/**
 * Cost under the owner's reported-usage policy: terminal reported steps times a
 * verified USD/step rate. This is not an invoice or a claim of final billing.
 * Call only when the owner-enabled policy flag is active. A null result retains
 * the financial hold; a valid zero-step terminal result returns the number 0.
 */
export function reportedAgentCostUsd(usage: ReportedAgentUsage, now = Date.now()): number | null {
  if (!usage || typeof usage !== 'object' || !Number.isFinite(now)) return null;
  if (
    typeof usage.expectedRunId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(usage.expectedRunId) ||
    usage.observedRunId !== usage.expectedRunId ||
    !['COMPLETED', 'FAILED', 'CANCELLED'].includes(usage.status as string) ||
    (usage.maxSteps !== AGENT_MAX_STEPS && usage.maxSteps !== LEGACY_AGENT_MAX_STEPS) ||
    typeof usage.numOfSteps !== 'number' ||
    !Number.isSafeInteger(usage.numOfSteps) ||
    usage.numOfSteps < 0 ||
    usage.numOfSteps > usage.maxSteps
  )
    return null;

  const verified = instant(usage.ratesVerifiedAt);
  if (verified === null || verified > now || now - verified > 24 * HOUR_MS) return null;
  // Omitted expiry represents the existing explicitly verified initial manual
  // proof. A supplied malformed/null/expired attestation may not fall back to it.
  if (usage.ratesExpiresAt !== undefined) {
    const expiry = instant(usage.ratesExpiresAt);
    if (expiry === null || expiry <= now || expiry <= verified || expiry - verified > 6 * HOUR_MS)
      return null;
  }
  const rate = scaledRate(usage.rateUsd);
  if (rate === null) return null;
  const total = BigInt(usage.numOfSteps) * rate;
  // Postgres stores six USD decimals. Round upward at that precision so the
  // ledger never understates an otherwise valid, more precise reported rate.
  const microdollars = (total + SCALED_UNITS_PER_MICRODOLLAR - 1n) / SCALED_UNITS_PER_MICRODOLLAR;
  return Number(microdollars) / 1_000_000;
}
