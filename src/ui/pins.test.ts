import { describe, expect, it, vi } from 'vitest';
import { postPin, postPinOrder } from './pins';

describe('postPin (F2)', () => {
  it('POSTs the toggle and returns the server pins', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ pins: ['s1'] }), { status: 200 }));
    expect(await postPin('s1', true, fetchFn as unknown as typeof fetch)).toEqual(['s1']);
    expect(fetchFn).toHaveBeenCalledWith('/api/pins', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 's1', pinned: true }) }));
  });

  it('throws the server error, or a Korean network error', async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: '잘못된 고정 요청입니다' }), { status: 400 }));
    await expect(postPin('s1', true, bad as unknown as typeof fetch)).rejects.toThrow('잘못된 고정 요청입니다');
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(postPin('s1', true, down as unknown as typeof fetch)).rejects.toThrow('고정 실패: 네트워크 오류');
  });
});

describe('postPinOrder', () => {
  it('POSTs the full order and returns the server pins', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ pins: ['b', 'a'] }), { status: 200 }));
    expect(await postPinOrder(['b', 'a'], fetchFn as unknown as typeof fetch)).toEqual(['b', 'a']);
    expect(fetchFn).toHaveBeenCalledWith('/api/pins/order', expect.objectContaining({ method: 'POST', body: JSON.stringify({ order: ['b', 'a'] }) }));
  });

  it('throws the server error, a status fallback, or a Korean network error', async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: '잘못된 고정 순서 요청입니다' }), { status: 400 }));
    await expect(postPinOrder(['a'], bad as unknown as typeof fetch)).rejects.toThrow('잘못된 고정 순서 요청입니다');
    const opaque = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(postPinOrder(['a'], opaque as unknown as typeof fetch)).rejects.toThrow('고정 순서 변경 실패 (500)');
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(postPinOrder(['a'], down as unknown as typeof fetch)).rejects.toThrow('고정 순서 변경 실패: 네트워크 오류');
  });
});
