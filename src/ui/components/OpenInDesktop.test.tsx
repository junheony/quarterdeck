// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OpenInDesktop } from './OpenInDesktop';

const SID = '33333333-3333-4333-8333-333333333333';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

function stub(body: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}
const ua = (v: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(v);
/** jsdom defines ontouchend everywhere; a non-touch desktop browser lacks it. Returns a restore function. */
function noTouch(): () => void {
  for (let o: object | null = document; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, 'ontouchend');
    if (d) { delete (o as Record<string, unknown>).ontouchend; return () => Object.defineProperty(o, 'ontouchend', d); }
  }
  return () => {};
}
let restore = () => {};
beforeEach(() => { restore = noTouch(); });

afterEach(() => { restore(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();  });

describe('OpenInDesktop', () => {
  it('is hidden off macOS and on touch clients', () => {
    ua('Mozilla/5.0 (X11; Linux x86_64)');
    expect(render(<OpenInDesktop sessionId={SID} onError={() => {}} />).container.textContent).toBe('');
    cleanup();
    ua(MAC);
    restore();
    expect(render(<OpenInDesktop sessionId={SID} onError={() => {}} />).container.textContent).toBe('');
  });

  it('posts, then navigates to the claude:// url', async () => {
    ua(MAC);
    const f = stub({ ok: true, url: `claude://resume?session=${SID}`, busy: false });
    const navigate = vi.fn();
    render(<OpenInDesktop sessionId={SID} onError={() => {}} navigate={navigate} />);
    fireEvent.click(screen.getByText('Desktop에서 열기'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`claude://resume?session=${SID}`));
    expect(f).toHaveBeenCalledWith(`/api/sessions/${SID}/open-in-desktop`, expect.objectContaining({ method: 'POST' }));
  });

  it('busy: asks first and does not navigate when declined', async () => {
    ua(MAC);
    stub({ ok: true, url: `claude://resume?session=${SID}`, busy: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const navigate = vi.fn();
    render(<OpenInDesktop sessionId={SID} onError={() => {}} navigate={navigate} />);
    fireEvent.click(screen.getByText('Desktop에서 열기'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('diverged and failures are reported, never navigated', async () => {
    ua(MAC);
    const onError = vi.fn();
    const navigate = vi.fn();
    stub({ ok: false, reason: 'diverged' });
    render(<OpenInDesktop sessionId={SID} onError={onError} navigate={navigate} />);
    fireEvent.click(screen.getByText('Desktop에서 열기'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('기록이 갈라져 있어 먼저 맞춰야 합니다')));
    stub({ error: '실패함' }, 500);
    fireEvent.click(screen.getByText('Desktop에서 열기'));
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('실패함'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
