// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useComposerSuggest } from './ComposerSuggest';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function Harness({ fetchFn, commands = true, sessionId = 's1' }: { fetchFn: typeof fetch; commands?: boolean; sessionId?: string | null }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const s = useComposerSuggest({ text, setText, textareaRef: ref, cwd: '/w/p', sessionId, commands, fetchFn });
  return (
    <div>
      {s.popup}
      <textarea aria-label="m" ref={ref} value={text} onChange={(e) => { setText(e.target.value); s.track(e); }} onSelect={s.track} onKeyDown={(e) => { s.onKeyDown(e); }} />
    </div>
  );
}

const type = (value: string) => fireEvent.change(screen.getByLabelText('m'), { target: { value } });
const box = () => screen.getByLabelText('m') as HTMLTextAreaElement;

describe('useComposerSuggest', () => {
  afterEach(cleanup);

  it('@ lists files for the cwd (fetched once), filters fuzzily, Enter inserts @path', async () => {
    const fetchFn = vi.fn(async () => json({ files: ['src/main.ts', 'src/ui/App.tsx', 'README.md'], truncated: false })) as unknown as typeof fetch;
    render(<Harness fetchFn={fetchFn} />);
    type('look @');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/api/files?cwd=%2Fw%2Fp');
    type('look @app');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['src/ui/App.tsx']);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('look @src/ui/App.tsx ');
    expect(screen.queryByTestId('composer-suggest')).toBeNull();
    type('look @src/ui/App.tsx and @mai');
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(box().value).toBe('look @src/ui/App.tsx and @src/main.ts ');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('/ at the start lists session commands; arrows move, Esc closes until the token changes', async () => {
    const fetchFn = vi.fn(async () => json({ commands: [{ name: 'compact', description: '대화 요약', argumentHint: '' }, { name: 'review', description: '', argumentHint: '<pr>' }, { name: 'context', description: '', argumentHint: '' }] })) as unknown as typeof fetch;
    render(<Harness fetchFn={fetchFn} />);
    type('/');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/api/commands?sessionId=s1&cwd=%2Fw%2Fp');
    expect(screen.getByText('대화 요약')).toBeTruthy();
    type('/co');
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.suggest-label')!.textContent)).toEqual(['/compact', '/context']);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByTestId('composer-suggest')).toBeNull();
    type('');
    type('/r');
    fireEvent.mouseDown(screen.getByText('/review'));
    expect(box().value).toBe('/review ');
  });

  it('no command popup (and no fetch) for engines without slash commands', async () => {
    const fetchFn = vi.fn(async () => json({ commands: [{ name: 'compact', description: '', argumentHint: '' }] })) as unknown as typeof fetch;
    render(<Harness fetchFn={fetchFn} commands={false} />);
    type('/co');
    expect(screen.queryByTestId('composer-suggest')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('shows the server error for a folder it may not list', async () => {
    const fetchFn = vi.fn(async () => json({ error: '허용되지 않은 폴더' }, 400)) as unknown as typeof fetch;
    render(<Harness fetchFn={fetchFn} />);
    type('@');
    await waitFor(() => expect(screen.getByText('허용되지 않은 폴더')).toBeTruthy());
  });
});
