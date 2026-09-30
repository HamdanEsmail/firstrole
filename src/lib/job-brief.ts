import type { Job } from '../../shared/types';

function requirementPriority(text: string): number {
  if (/^(?:preferred|desirable|nice to have)\b/i.test(text)) return 0;
  if (
    /\b(?:must|required|minimum|only|nationals?|citizens?|family book|work authori[sz]ation|right to work)\b/i.test(
      text,
    )
  )
    return 3;
  if (/\b(?:preferred|desirable|nice to have)\b/i.test(text)) return 0;
  return /\b(?:degree|bachelor|master|ph\.?d|enroll(?:ed|ment)?|graduat(?:e|ion|ing)|experience|years?|months?)\b/i.test(
    text,
  )
    ? 2
    : 1;
}

export function importantRequirements(job: Job, limit = 3): string[] {
  const seen = new Set<string>();
  return job.requirements
    .map((text, index) => ({ text: text.trim(), index }))
    .filter(({ text }) => {
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item, priority: requirementPriority(item.text) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ text }) => text);
}

export function availabilityLabel(job: Job): string {
  return job.availability === 'open'
    ? 'Open on source'
    : job.availability === 'closed'
      ? 'Closed'
      : 'Could not verify';
}

export function payLabel(job: Job): string {
  return job.salary?.text || 'Pay not listed';
}

export function postingDateLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not stated';
  // A source's calendar date must not move back a day in western timezones.
  return new Date(value).toLocaleDateString(
    undefined,
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : undefined,
  );
}
