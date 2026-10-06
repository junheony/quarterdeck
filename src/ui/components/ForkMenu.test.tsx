// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ForkMenu } from './ForkMenu';

const SID = '33333333-3333-4333-8333-333333333333';

function stubFetch(diverged: boolean) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const body = init?.method === 'POST' ? { ok: true } : { diverged, deckAccount: 'b', homeAccount: 'a' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ForkMenu', () => {
  it('renders nothing when the copies have not diverged', async () => {
    const calls = stubFetch(false);
    const { container } = render(<ForkMenu sessionId={SID} busy={false} onResolved={() => {}} onError={() => {}} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.textContent).toBe('');
  });

  it('offers both directions when diverged and posts the chosen one after confirmation', async () => {
    const calls = stubFetch(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onResolved = vi.fn();
    render(<ForkMenu sessionId={SID} busy={false} onResolved={onResolved} onError={() => {}} />);
    fireEvent.click(await screen.findByText('갈라짐'));
    expect(screen.getByText('deck 을 Desktop 대화로 맞추기')).toBeTruthy();
    fireEvent.click(screen.getByText('Desktop 쪽을 deck 대화로 맞추기'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(calls.find((c) => c.body)).toEqual({ url: '/api/session-fork', body: { sessionId: SID, keep: 'deck' } });
  });
});
