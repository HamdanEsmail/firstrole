import { describe, expect, it } from 'vitest';
import type { SavedJob } from '../shared/types';
import {
  GUEST_STORAGE_KEY,
  emptyGuestWorkspace,
  readGuestWorkspace,
  writeGuestWorkspace,
  mergeGuestSaved,
  removeConfirmedImports,
  parseSavedRow,
  savedToRow,
  type StorageLike,
} from '../src/lib/storage';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function saved(id = 'job-1', overrides: Partial<SavedJob> = {}): SavedJob {
  return {
    job: {
      id,
      title: 'Graduate Data Analyst',
      company: 'Test Employer',
      location: 'Dubai',
      workplace: 'onsite',
      remoteRegion: null,
      employmentType: 'graduate',
      sourceUrl: 'https://example.com/jobs/1',
      applyUrl: 'https://example.com/apply/1',
      requisitionId: 'TEST-1',
      description: 'A test-only job fixture.',
      requirements: ['Data analysis'],
      salary: null,
      postedAt: null,
      deadline: null,
      checkedAt: '2026-09-29T12:00:00Z',
      sponsorship: 'not-stated',
      evidence: [],
      availability: 'open',
      match: { tier: 'Good match', reasons: ['Graduate role'], score: 60 },
    },
    status: 'Saved',
    notes: '',
    appliedAt: null,
    savedAt: '2026-09-29T12:00:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    ...overrides,
  };
}
describe('guest workspace persistence', () => {
  it('round trips notes, dates, unknown fields and preferences without inventing values', () => {
    const storage = new MemoryStorage();
    const workspace = {
      ...emptyGuestWorkspace(),
      saved: [
        saved('job-1', {
          status: 'Applied',
          notes: 'Follow up next week',
          appliedAt: '2026-09-29T00:00:00.000Z',
        }),
      ],
    };
    workspace.preferences.location = 'Dubai';
    writeGuestWorkspace(storage, workspace);
    expect(readGuestWorkspace(storage)).toEqual({ workspace, error: null });
    expect(readGuestWorkspace(storage).workspace.saved[0].job.salary).toBeNull();
  });
  it('preserves malformed original storage and reports the problem', () => {
    const storage = new MemoryStorage();
    storage.setItem(GUEST_STORAGE_KEY, '{truncated original');
    expect(readGuestWorkspace(storage).error).toContain('preserved');
    expect(storage.getItem(GUEST_STORAGE_KEY)).toBe('{truncated original');
  });
  it('rejects unsafe application links in restored data', () => {
    const storage = new MemoryStorage();
    const item = saved();
    item.job.applyUrl = 'javascript:alert(1)';
    storage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ ...emptyGuestWorkspace(), saved: [item] }));
    expect(readGuestWorkspace(storage).workspace.saved).toHaveLength(0);
    expect(readGuestWorkspace(storage).error).not.toBeNull();
  });
  it('refuses unsupported versions without replacing the original', () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify({ ...emptyGuestWorkspace(), version: 2, saved: [saved()] });
    storage.setItem(GUEST_STORAGE_KEY, original);
    expect(readGuestWorkspace(storage).error).not.toBeNull();
    expect(storage.getItem(GUEST_STORAGE_KEY)).toBe(original);
  });
  it('does not claim persistence when browser quota or privacy settings block a write', () => {
    const storage: StorageLike = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeGuestWorkspace(storage, emptyGuestWorkspace())).toThrow('not saved');
    expect(() => writeGuestWorkspace(null, emptyGuestWorkspace())).toThrow('not saved');
  });
  it('does not share mutable defaults between workspaces', () => {
    const first = emptyGuestWorkspace();
    const second = emptyGuestWorkspace();
    first.preferences.jobTypes.push('entry-level');
    expect(second.preferences.jobTypes).toEqual(['internship', 'graduate']);
  });
});
describe('account import and database conversion', () => {
  it('preserves account notes and status for duplicates while importing new guest jobs', () => {
    const account = saved('same', { status: 'Interviewing', notes: 'Account interview notes' });
    const guest = saved('same', {
      status: 'Saved',
      notes: 'Guest note',
      updatedAt: '2026-09-30T12:00:00Z',
    });
    const merged = mergeGuestSaved([account], [guest, saved('new')]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.job.id === 'same')).toEqual(account);
  });
  it('clears only verified imported records and retains unconfirmed records', () => {
    const first = saved('first');
    const second = saved('second');
    expect(removeConfirmedImports([first, second], [first, second], new Set(['first']))).toEqual([
      second,
    ]);
  });
  it('retains new jobs and changes made in another tab during import', () => {
    const original = saved('first');
    const edited = {
      ...original,
      notes: 'Changed while importing',
      updatedAt: '2026-09-30T12:00:00Z',
    };
    const added = saved('new');
    expect(removeConfirmedImports([edited, added], [original], new Set(['first']))).toEqual([
      edited,
      added,
    ]);
  });
  it('maps account rows while retaining explicit owner and nullable dates', () => {
    const original = saved();
    const row = savedToRow(original, 'account-a');
    expect(row.user_id).toBe('account-a');
    expect(row.job_id).toBe(original.job.id);
    expect(parseSavedRow(row)).toEqual(original);
  });
});
