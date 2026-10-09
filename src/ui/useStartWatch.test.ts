// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { newPane, type PaneState } from './state';
import { START_STALL_MS, useStartWatch } from './useStartWatch';

const waiting = (ref: string, id = 'p0'): PaneState => ({ ...newPane(id), awaitingStart: true, awaitingRef: ref });

describe('useStartWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reconnects once when a send has waited START_STALL_MS for its turn_started', () => {
    const reconnect = vi.fn();
    const { rerender } = renderHook(({ panes, connected }) => useStartWatch(panes, connected, reconnect), { initialProps: { panes: [waiting('r1')], connected: true } });
    vi.advanceTimersByTime(START_STALL_MS - 1);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Still the same wait (re-renders, time passing): never twice.
    rerender({ panes: [waiting('r1')], connected: true });
    vi.advanceTimersByTime(START_STALL_MS * 3);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('a wait that ends in time, or while disconnected, does nothing; a new wait (even under the same ref) counts from its own start', () => {
    const reconnect = vi.fn();
    const { rerender } = renderHook(({ panes, connected }) => useStartWatch(panes, connected, reconnect), { initialProps: { panes: [waiting('r1')], connected: true } });
    vi.advanceTimersByTime(START_STALL_MS / 2);
    rerender({ panes: [newPane('p0')], connected: true });
    vi.advanceTimersByTime(START_STALL_MS);
    expect(reconnect).not.toHaveBeenCalled();
    rerender({ panes: [waiting('r1')], connected: false });
    vi.advanceTimersByTime(START_STALL_MS * 2);
    expect(reconnect).not.toHaveBeenCalled();
    rerender({ panes: [newPane('p0')], connected: true });
    rerender({ panes: [waiting('r1')], connected: true });
    vi.advanceTimersByTime(START_STALL_MS - 1);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('another pane starting to wait does not push back the first one\'s deadline', () => {
    const reconnect = vi.fn();
    const { rerender } = renderHook(({ panes }) => useStartWatch(panes, true, reconnect), { initialProps: { panes: [waiting('r1')] } });
    vi.advanceTimersByTime(START_STALL_MS - 1000);
    rerender({ panes: [waiting('r1'), waiting('r2', 'p1')] });
    vi.advanceTimersByTime(1000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
