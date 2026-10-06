// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { AFTER_TURN_WAIT_MS, INDEX_REFRESH_EVERY_MS, INDEX_REFRESH_MIN_GAP_MS, throttled, useIndexRefresh } from './indexRefresh';

afterEach(() => { vi.useRealTimers(); });

describe('throttled', () => {
  it('request: runs now, or not at all inside the gap', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const t = throttled(run, 1000);
    t.request();
    t.request();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
    t.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('afterTurn: nothing when the server sends its own index in time (newer server); a rescan when none comes (older server)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const t = throttled(run, 1000, Date.now, 300);
    t.afterTurn();
    vi.advanceTimersByTime(100);
    t.indexSeen();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    t.afterTurn();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
    // Inside the gap: one rescan at its end, however many turns end.
    t.afterTurn();
    vi.advanceTimersByTime(300);
    t.afterTurn();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(2);
    t.afterTurn();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('useIndexRefresh', () => {
  it('asks on coming back into view and periodically while visible; never more than once per gap', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const { result, unmount } = renderHook(() => useIndexRefresh(true, send));
    result.current.request(); // reconnect
    document.dispatchEvent(new Event('visibilitychange')); // coming into view at the same time: not a second rescan
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INDEX_REFRESH_MIN_GAP_MS);
    expect(send).toHaveBeenCalledTimes(1);
    result.current.afterTurn(); // an older server: no index after the turn
    vi.advanceTimersByTime(AFTER_TURN_WAIT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(INDEX_REFRESH_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(3);
    state = 'hidden';
    vi.advanceTimersByTime(INDEX_REFRESH_EVERY_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(send).toHaveBeenCalledTimes(4);
    unmount();
    vi.advanceTimersByTime(INDEX_REFRESH_EVERY_MS * 2);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
