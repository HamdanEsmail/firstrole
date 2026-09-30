export type MatchReasonTone = 'positive' | 'caution' | 'neutral';

export function matchReasonTone(reason: string): MatchReasonTone {
  if (
    /\b(needs checking|could not|cannot|unable|unavailable|restricted|not (?:available|eligible|confirmed))\b/i.test(
      reason,
    )
  )
    return 'caution';
  if (/\b(not stated|not listed|unknown)\b/i.test(reason)) return 'neutral';
  // Only known positive evidence gets a check mark. New or descriptive reasons
  // stay neutral until their meaning has an explicit presentation rule.
  if (
    /^(?:Title includes |Location matches |Remote eligibility includes |Mentions )/i.test(reason) ||
    /^(?:Sponsorship explicitly mentioned|(?:Entry-level|Graduate|Internship) opportunity)$/i.test(
      reason,
    )
  )
    return 'positive';
  return 'neutral';
}
