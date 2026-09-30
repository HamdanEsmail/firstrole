import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPreview, SearchRun } from '../shared/types';
import { ApiError, getAgentPreview } from '../src/lib/api';
import { canShowAgentPreview, observeAgentPreview } from '../src/lib/agent-preview';
import { AgentPreviewPanel } from '../src/components/AgentPreview';

vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  getAgentPreview: vi.fn(),
}));
const viewer = 'https://tf-test123.fra0-tinyfish.unikraft.app/stream/0';
const readPreview = vi.mocked(getAgentPreview);

beforeEach(() => {
  vi.useFakeTimers();
  readPreview.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('preview lifetime and owner isolation', () => {
  it('allows only a ready, current, uncached extracting search', () => {
    const run = { id: 'private-run', status: 'extracting', cached: false } as SearchRun;
    expect(canShowAgentPreview(run, true, false)).toBe(true);
    expect(canShowAgentPreview(run, false, false)).toBe(false);
    expect(canShowAgentPreview(run, true, true)).toBe(false);
    expect(canShowAgentPreview({ ...run, cached: true }, true, false)).toBe(false);
    expect(canShowAgentPreview(null, true, false)).toBe(false);
    for (const status of [
      'queued',
      'discovering',
      'reading',
      'verifying',
      'completed',
      'partial',
      'failed',
      'cancelled',
    ] as SearchRun['status'][]) {
      expect(canShowAgentPreview({ ...run, status }, true, false)).toBe(false);
    }
  });

  it('drops an old account/search response after its subscription is removed', async () => {
    let resolve!: (preview: AgentPreview) => void;
    readPreview.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onChange = vi.fn();
    const stop = observeAgentPreview('old-owner-run', 'old-owner-token', onChange);
    stop();
    resolve({ status: 'live', url: viewer });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange.mock.calls).toEqual([[{ status: 'checking' }]]);
    expect(readPreview).toHaveBeenCalledExactlyOnceWith('old-owner-run', 'old-owner-token');
  });

  it('waits for the actual URL then stops polling without persisting the capability', async () => {
    const storageWrite = vi.fn();
    vi.stubGlobal('localStorage', { setItem: storageWrite });
    vi.stubGlobal('sessionStorage', { setItem: storageWrite });
    readPreview.mockResolvedValueOnce({ status: 'waiting', sourceName: 'Careers' });
    readPreview.mockResolvedValueOnce({ status: 'live', url: viewer, sourceName: 'Careers' });
    const onChange = vi.fn();
    const stop = observeAgentPreview('current-run', 'current-token', onChange);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readPreview).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({
      status: 'live',
      url: viewer,
      sourceName: 'Careers',
    });
    expect(storageWrite).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
  });

  it.each(['ended', 'unavailable'] as const)('does not retry a %s session', async (status) => {
    readPreview.mockResolvedValue({ status });
    const onChange = vi.fn();
    const stop = observeAgentPreview('run', null, onChange);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenLastCalledWith({ status, sourceName: undefined });
    expect(readPreview).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fails closed for a URL outside the official viewer allowlist', async () => {
    readPreview.mockResolvedValue({ status: 'live', url: 'https://untrusted.example/stream/0' });
    const onChange = vi.fn();
    const stop = observeAgentPreview('run', null, onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenLastCalledWith({ status: 'unavailable', sourceName: undefined });
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('untrusted.example');
    stop();
  });

  it('stops immediately when ownership authorization expires', async () => {
    readPreview.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'));
    const onChange = vi.fn();
    const stop = observeAgentPreview('run', 'expired-token', onChange);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenLastCalledWith({ status: 'unavailable' });
    expect(readPreview).toHaveBeenCalledTimes(1);
    stop();
  });

  it('bounds failed and indefinitely waiting requests instead of polling forever', async () => {
    const onChange = vi.fn();
    readPreview.mockRejectedValue(new ApiError(0, 'offline', 'Unavailable'));
    const stopFailed = observeAgentPreview('run', null, onChange);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readPreview).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith({ status: 'unavailable' });
    stopFailed();
    readPreview.mockReset().mockResolvedValue({ status: 'waiting' });
    const stopWaiting = observeAgentPreview('run', null, onChange);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(readPreview.mock.calls.length).toBeGreaterThan(30);
    expect(onChange).toHaveBeenLastCalledWith({ status: 'waiting', sourceName: undefined });
    await vi.advanceTimersByTimeAsync(500_000);
    expect(readPreview).toHaveBeenCalledTimes(100);
    expect(onChange).toHaveBeenLastCalledWith({ status: 'unavailable' });
    stopWaiting();
  });
});

describe('view-only preview presentation', () => {
  it('keeps keyboard/pointer interaction out of the embedded browser and restricts its capabilities', () => {
    const html = renderToStaticMarkup(
      createElement(AgentPreviewPanel, {
        preview: { status: 'live', url: viewer, sourceName: 'R&amp;D &lt;img&gt;' },
      }),
    );
    expect(html).toContain(`src="${viewer}"`);
    expect(html).toContain('inert=""');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain('allow-forms');
    expect(html).not.toContain('allow-popups');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).not.toContain(`href="${viewer}"`);
    expect(html).toContain('R&amp;D &lt;img&gt;');
    expect(html).not.toContain('<img>');
    expect(html).toContain('Hide preview');
    expect(html).toContain('View only');
  });

  it.each(['checking', 'waiting', 'unavailable', 'ended', 'offline'] as const)(
    'shows an honest %s state without an iframe or invented activity',
    (status) => {
      const html = renderToStaticMarkup(createElement(AgentPreviewPanel, { preview: { status } }));
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('src=');
      expect(html).not.toContain('typing');
      expect(html).toContain('TinyFish Agent');
    },
  );

  it('does not render an iframe for a malformed live capability', () => {
    const html = renderToStaticMarkup(
      createElement(AgentPreviewPanel, { preview: { status: 'live', url: 'javascript:alert(1)' } }),
    );
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('preview is unavailable');
  });
});
