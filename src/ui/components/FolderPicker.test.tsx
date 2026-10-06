// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FolderPicker, splitInput } from './FolderPicker';

const H = '/Users/u';

function fakeFetch(opts: { postStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/recent-folders' && init?.method === 'POST') {
      if (opts.postStatus && opts.postStatus !== 200) return ok({ error: '홈 폴더 안의 경로만 열 수 있습니다' }, opts.postStatus);
      const p = String((JSON.parse(String(init.body)) as { path: string }).path).replace(/^~\//, `${H}/`).replace(/\/$/, '');
      return ok({ path: p, recent: [p] });
    }
    if (url === '/api/recent-folders') return ok({ recent: [`${H}/Documents/old`] });
    if (url.startsWith('/api/dirs')) {
      const p = new URL(url, 'http://x').searchParams.get('path');
      if (p === '~/Documents/') return ok({ path: `${H}/Documents`, parent: H, dirs: [{ name: '작업', path: `${H}/Documents/작업` }, { name: 'Work', path: `${H}/Documents/Work` }, { name: 'web', path: `${H}/Documents/web` }] });
      return ok({ path: H, parent: null, dirs: [{ name: 'Documents', path: `${H}/Documents` }] });
    }
    return ok({}, 404);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('splitInput', () => {
  it('splits a typed path into the directory to list and the name prefix', () => {
    expect(splitInput('~/Documents/')).toEqual({ dir: '~/Documents/', prefix: '' });
    expect(splitInput('~/Documents/we')).toEqual({ dir: '~/Documents/', prefix: 'we' });
    expect(splitInput('~')).toEqual({ dir: '~', prefix: '' });
    expect(splitInput('/Users')).toEqual({ dir: '/', prefix: 'Users' });
    expect(splitInput('')).toEqual({ dir: '~', prefix: '' });
  });
});

describe('FolderPicker (F1)', () => {
  afterEach(cleanup);

  it('shows recent folders and autocompletes subfolders, filtered by the typed prefix', async () => {
    const { fn } = fakeFetch();
    render(<FolderPicker onOpen={() => {}} onClose={() => {}} fetchFn={fn} />);
    expect(await screen.findByText(`${H}/Documents/old`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/Documents/w' } });
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy());
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.queryByText('작업')).toBeNull();
  });

  it('clicking a suggestion descends into it; Enter opens the typed folder via the server', async () => {
    const { fn, calls } = fakeFetch();
    const onOpen = vi.fn();
    render(<FolderPicker onOpen={onOpen} onClose={() => {}} fetchFn={fn} />);
    const input = screen.getByLabelText('폴더 경로') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '~/Documents/' } });
    fireEvent.click(await screen.findByText('작업'));
    expect(input.value).toBe(`${H}/Documents/작업/`);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${H}/Documents/작업`));
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/recent-folders');
  });

  it('a recent folder opens with one click; a refused path shows the server error', async () => {
    const ok = fakeFetch();
    const onOpen = vi.fn();
    render(<FolderPicker onOpen={onOpen} onClose={() => {}} fetchFn={ok.fn} />);
    fireEvent.click(await screen.findByText(`${H}/Documents/old`));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${H}/Documents/old`));
    cleanup();
    const bad = fakeFetch({ postStatus: 400 });
    const onOpen2 = vi.fn();
    render(<FolderPicker onOpen={onOpen2} onClose={() => {}} fetchFn={bad.fn} />);
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByText('열기'));
    expect(await screen.findByText('홈 폴더 안의 경로만 열 수 있습니다')).toBeTruthy();
    expect(onOpen2).not.toHaveBeenCalled();
  });
});
