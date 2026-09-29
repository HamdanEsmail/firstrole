import { z } from 'zod';
import {
  DEFAULT_PREFERENCES,
  APPLICATION_STATUSES,
  type Job,
  type SavedJob,
  type SearchPreferences,
} from '../../shared/types';

export const GUEST_STORAGE_KEY = 'firstrole.workspace.v1';
export const GUEST_ID_KEY = 'firstrole.guest.v1';
export const ACTIVE_SEARCH_KEY = 'firstrole.search.v1';
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'A web address is required');
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
export const preferencesSchema = z.object({
  role: z.string().max(160),
  location: z.string().max(160),
  jobTypes: z.array(z.enum(['internship', 'graduate', 'entry-level'])).max(3),
  workplaces: z.array(z.enum(['remote', 'hybrid', 'onsite'])).max(3),
  keywords: z.string().max(500),
  sponsorshipRequired: z.boolean(),
  postedWithinDays: z.number().int().min(1).max(365).nullable(),
});
export const jobSchema: z.ZodType<Job> = z.object({
  id: z.string().min(1).max(250),
  title: z.string().min(1).max(1000),
  company: z.string().min(1).max(500),
  location: z.string().max(1000),
  workplace: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  remoteRegion: z.string().max(1000).nullable(),
  employmentType: z.enum(['internship', 'graduate', 'entry-level', 'unknown']),
  sourceUrl: httpUrl,
  applyUrl: httpUrl,
  requisitionId: z.string().max(500).nullable(),
  description: z.string().max(100000),
  requirements: z.array(z.string().max(10000)).max(100),
  salary: z
    .object({
      text: z.string().max(2000),
      currency: z.string().nullable(),
      period: z.string().nullable(),
    })
    .nullable(),
  postedAt: timestamp.nullable(),
  deadline: timestamp.nullable(),
  checkedAt: timestamp,
  sponsorship: z.enum(['available', 'unavailable', 'not-stated']),
  evidence: z
    .array(z.object({ field: z.string(), text: z.string().max(10000), sourceUrl: httpUrl }))
    .max(200),
  availability: z.enum(['open', 'closed', 'unverified']),
  match: z.object({
    tier: z.enum(['Strong match', 'Good match', 'Possible match']),
    reasons: z.array(z.string()),
    score: z.number().finite(),
  }),
});
export const savedJobSchema: z.ZodType<SavedJob> = z.object({
  job: jobSchema,
  status: z.enum(
    APPLICATION_STATUSES as ['Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'],
  ),
  notes: z.string().max(10000),
  appliedAt: timestamp.nullable(),
  savedAt: timestamp,
  updatedAt: timestamp,
});
export interface GuestWorkspace {
  version: 1;
  saved: SavedJob[];
  preferences: SearchPreferences;
}
export interface ReadResult {
  workspace: GuestWorkspace;
  error: string | null;
}
export function emptyGuestWorkspace(): GuestWorkspace {
  return {
    version: 1,
    saved: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      jobTypes: [...DEFAULT_PREFERENCES.jobTypes],
      workplaces: [],
    },
  };
}
const workspaceSchema = z.object({
  version: z.literal(1),
  saved: z.array(savedJobSchema).max(500),
  preferences: preferencesSchema,
});

export function readGuestWorkspace(storage: StorageLike | null): ReadResult {
  if (!storage)
    return {
      workspace: emptyGuestWorkspace(),
      error:
        'Browser storage is unavailable. Enable storage to keep your saved jobs on this device.',
    };
  try {
    const raw = storage.getItem(GUEST_STORAGE_KEY);
    if (!raw) return { workspace: emptyGuestWorkspace(), error: null };
    const parsed = workspaceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return {
        workspace: emptyGuestWorkspace(),
        error:
          'Your saved browser data could not be read. The original data has been preserved; export or recover it before saving new jobs.',
      };
    return {
      workspace: { ...parsed.data, saved: deduplicateSaved(parsed.data.saved) },
      error: null,
    };
  } catch {
    return {
      workspace: emptyGuestWorkspace(),
      error:
        'Your saved browser data could not be read. Check your browser storage settings; the original data has been preserved.',
    };
  }
}
export function writeGuestWorkspace(storage: StorageLike | null, workspace: GuestWorkspace): void {
  if (!storage) throw new Error('Browser storage is unavailable. This change was not saved.');
  const parsed = workspaceSchema.safeParse(workspace);
  if (!parsed.success)
    throw new Error(
      'This change could not be saved because some job or preference data is invalid.',
    );
  try {
    storage.setItem(GUEST_STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    throw new Error(
      'Browser storage is full or disabled. This change was not saved. Export your jobs or enable storage, then try again.',
    );
  }
}
export function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
export function deduplicateSaved(saved: SavedJob[]): SavedJob[] {
  const unique = new Map<string, SavedJob>();
  for (const item of saved) {
    const previous = unique.get(item.job.id);
    if (!previous || Date.parse(item.updatedAt) > Date.parse(previous.updatedAt))
      unique.set(item.job.id, item);
  }
  return [...unique.values()];
}
/** Account records always win, including their notes and application status. */
export function mergeGuestSaved(account: SavedJob[], guest: SavedJob[]): SavedJob[] {
  const merged = new Map(deduplicateSaved(guest).map((item) => [item.job.id, item]));
  for (const item of deduplicateSaved(account)) merged.set(item.job.id, item);
  return [...merged.values()];
}
/** Preserve edits made in another tab while an import was in flight. */
export function removeConfirmedImports(
  current: SavedJob[],
  imported: SavedJob[],
  confirmedIds: Set<string>,
): SavedJob[] {
  const snapshots = new Map(imported.map((item) => [item.job.id, JSON.stringify(item)]));
  return current.filter(
    (item) => !confirmedIds.has(item.job.id) || snapshots.get(item.job.id) !== JSON.stringify(item),
  );
}
export function parseSavedRow(row: Record<string, unknown>): SavedJob {
  return savedJobSchema.parse({
    job: row.job,
    status: row.status,
    notes: row.notes,
    appliedAt: row.applied_at,
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
  });
}
export function savedToRow(saved: SavedJob, userId: string): Record<string, unknown> {
  return {
    user_id: userId,
    job_id: saved.job.id,
    job: saved.job,
    status: saved.status,
    notes: saved.notes,
    applied_at: saved.appliedAt,
    saved_at: saved.savedAt,
    updated_at: saved.updatedAt,
  };
}
