import { describe, expect, it, vi } from 'vitest';
import type { SearchRun } from '../shared/types';
import type { Database } from '../server/db';
import { finishOrHandoffSearch } from '../server/workflow-finalization';

function run(): SearchRun {
  return {
    id: crypto.randomUUID(),
    status: 'verifying',
    stage: 'Checking',
    preferences: {
      role: 'Engineering',
      location: 'United States',
      keywords: '',
      jobTypes: ['internship'],
      workplaces: [],
      postedWithinDays: null,
      sponsorshipRequired: false,
    },
    results: [],
    sources: [],
    errors: [],
    cached: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function store(current: SearchRun) {
  return {
    internal: vi
      .fn()
      .mockResolvedValue({ payload: structuredClone(current), cancelRequested: false }),
    update: vi.fn(async (value: SearchRun) => structuredClone(value)),
    rpc: vi.fn().mockResolvedValue(true),
  };
}

describe('one bounded finalization path', () => {
  it('does not start optional work after cancellation', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn();
    db.internal.mockResolvedValue({ payload: structuredClone(current), cancelRequested: true });
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe(
      'cancelled',
    );
    expect(current.status).toBe('cancelled');
    expect(start).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('honors cancellation committed between the initial read and publishing', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn();
    db.update.mockResolvedValue({ ...current, status: 'cancelled' });
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe(
      'cancelled',
    );
    expect(start).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledOnce();
  });
  it('preserves an existing terminal run and never creates another child', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn();
    db.internal.mockResolvedValue({
      payload: { ...current, status: 'completed' },
      cancelRequested: false,
    });
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe('finished');
    expect(start).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it('fails closed when the cancellation read fails, without retrying paid work', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn();
    db.internal.mockRejectedValue(new Error('storage unavailable'));
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe(
      'storage-unavailable',
    );
    expect(db.internal).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it('attempts a failed handoff once and saves terminal state at most twice without caching', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn().mockRejectedValue(new Error('response lost'));
    db.update
      .mockResolvedValueOnce({ ...current, status: 'reading' })
      .mockRejectedValueOnce(new Error('update lost'))
      .mockResolvedValueOnce({ ...current, status: 'failed' });
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe('finished');
    expect(start).toHaveBeenCalledOnce();
    expect(db.internal).toHaveBeenCalledOnce();
    expect(db.update).toHaveBeenCalledTimes(3);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('never creates a child when publishing fails and leaves a failed workflow after bounded storage failures', async () => {
    const current = run();
    const db = store(current);
    const start = vi.fn();
    db.update.mockRejectedValue(new Error('storage unavailable'));
    expect(await finishOrHandoffSearch(db as unknown as Database, current, start)).toBe(
      'storage-unavailable',
    );
    expect(start).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(3);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
