// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { filesFrom, uploadFile, useUploads } from './upload';
import { MAX_ATTACHMENT_BYTES } from '../shared/protocol';

describe('uploadFile', () => {
  it('POSTs the file with its name URL-encoded and returns the server record; a failure surfaces the server message', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'id-1', name: '스샷.png', mediaType: 'image/png', size: 3, isImage: true }), { status: 201 });
    });
    const file = new File([new Uint8Array([1, 2, 3])], '스샷.png', { type: 'image/png' });
    expect(await uploadFile(file, fetchFn as unknown as typeof fetch)).toEqual({ id: 'id-1', name: '스샷.png', size: 3, isImage: true, previewUrl: expect.stringMatching(/^blob:/) });
    expect(calls[0]?.url).toBe('/api/attachments');
    expect((calls[0]?.init.headers as Record<string, string>)['x-deck-filename']).toBe(encodeURIComponent('스샷.png'));
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: '첨부가 너무 큽니다' }), { status: 413 }));
    await expect(uploadFile(file, bad as unknown as typeof fetch)).rejects.toThrow('첨부가 너무 큽니다');
  });

  it('turns a rejected fetch (offline/DNS/etc.) into a Korean network-error message', async () => {
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(uploadFile(file, offline as unknown as typeof fetch)).rejects.toThrow('업로드 실패: 네트워크 오류');
  });
});

describe('useUploads', () => {
  it('uploads each file, reports uploaded records, caps at the per-turn limit and keeps the last error', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: f.type.startsWith('image/') }));
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads({ uploadFn, current: 7, onUploaded }));
    await act(() => result.current.addFiles([new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.txt')]));
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith({ id: 'id-a.png', name: 'a.png', size: 1, isImage: true });
    expect(result.current.error).toContain('최대 8개');
    expect(result.current.uploading).toBe(0);
    uploadFn.mockRejectedValueOnce(new Error('업로드 실패'));
    const h2 = renderHook(() => useUploads({ uploadFn, current: 0, onUploaded }));
    await act(() => h2.result.current.addFiles([new File(['c'], 'c.txt')]));
    expect(h2.result.current.error).toBe('업로드 실패');
  });

  it('rejects an oversize file before ever calling uploadFn, with a Korean size message', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: false }));
    const onUploaded = vi.fn();
    const big = new File([new Uint8Array(1)], 'big.bin');
    Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    const { result } = renderHook(() => useUploads({ uploadFn, current: 0, onUploaded }));
    await act(() => result.current.addFiles([big]));
    expect(uploadFn).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(result.current.error).toContain('MiB');
  });

  it('caps combined uploads across two concurrent addFiles calls sharing the same turn budget', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: false }));
    const onUploaded = vi.fn();
    // current=6, MAX=8 → 2 slots of room total; two calls each offering 2 files race for it.
    const { result } = renderHook(() => useUploads({ uploadFn, current: 6, onUploaded }));
    const filesA = [new File(['a'], 'a1.txt'), new File(['a'], 'a2.txt')];
    const filesB = [new File(['b'], 'b1.txt'), new File(['b'], 'b2.txt')];
    await act(async () => {
      await Promise.all([result.current.addFiles(filesA), result.current.addFiles(filesB)]);
    });
    expect(onUploaded).toHaveBeenCalledTimes(2);
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(result.current.error).toContain('최대 8개');
    expect(result.current.uploading).toBe(0);
  });
});

describe('filesFrom', () => {
  it('reads files from a DataTransfer-like object and ignores non-file items', () => {
    const f = new File(['x'], 'x.png', { type: 'image/png' });
    expect(filesFrom({ files: [f] as unknown as FileList, items: undefined as unknown as DataTransferItemList } as unknown as DataTransfer)).toEqual([f]);
    expect(filesFrom(null)).toEqual([]);
  });
});
