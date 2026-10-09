// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ERROR_TOAST_MS, INFO_TOAST_MS, MAX_TOASTS, Toasts, type ToastItem } from './Toasts';

function Harness({ initial }: { initial: ToastItem[] }) {
  const [toasts, setToasts] = useState(initial);
  return <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />;
}

describe('Toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('renders errors as alerts and info as status, newest on top', () => {
    render(<Harness initial={[{ id: 1, text: 'first', kind: 'error' }, { id: 2, text: 'second', kind: 'info' }]} />);
    expect(screen.getByRole('alert').textContent).toContain('first');
    expect(screen.getByRole('status').textContent).toContain('second');
    const texts = [...document.querySelectorAll('.toasts > .toast-item')].map((e) => e.textContent);
    expect(texts[0]).toContain('second');
    expect(texts[1]).toContain('first');
  });

  it('the × closes one toast', () => {
    render(<Harness initial={[{ id: 1, text: 'a', kind: 'error' }, { id: 2, text: 'b', kind: 'error' }]} />);
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[0]!); // newest first: closes 'b'
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.getByText('a')).toBeTruthy();
  });

  it('auto-dismisses info after INFO_TOAST_MS and errors after ERROR_TOAST_MS', () => {
    render(<Harness initial={[{ id: 1, text: 'err', kind: 'error' }, { id: 2, text: 'note', kind: 'info' }]} />);
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1); });
    expect(screen.getByText('note')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('note')).toBeNull();
    expect(screen.getByText('err')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(ERROR_TOAST_MS - INFO_TOAST_MS); });
    expect(screen.queryByText('err')).toBeNull();
  });

  it('kind defaults to error', () => {
    render(<Harness initial={[{ id: 1, text: 'x' }]} />);
    expect(screen.getByRole('alert').textContent).toContain('x');
  });

  it(`shows at most ${MAX_TOASTS}, the newest`, () => {
    render(<Harness initial={[1, 2, 3, 4, 5].map((id) => ({ id, text: `t${id}` }))} />);
    expect(document.querySelectorAll('.toast-item')).toHaveLength(MAX_TOASTS);
    expect(screen.queryByText('t1')).toBeNull();
    expect(screen.getByText('t5')).toBeTruthy();
  });

  it('renders nothing when empty', () => {
    render(<Toasts toasts={[]} onDismiss={() => {}} />);
    expect(document.querySelector('.toasts')).toBeNull();
  });
});
