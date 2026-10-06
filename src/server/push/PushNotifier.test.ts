import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import { PushNotifier, firstLine, selectPush, type PushSender } from './PushNotifier';
import { SubscriptionStore } from './SubscriptionStore';

const scope = { turnId: 't1', sessionId: 's1', cwd: '/Users/alice/dev/proj' };
const titleOf = (sid: string | null, cwd: string) => (sid === 's1' ? '로그인 버그 고치기' : cwd.split('/').pop() ?? 'deck');

describe('firstLine', () => {
  it('skips blank lines and markdown marks', () => {
    expect(firstLine('\n\n## 결과\n둘째 줄')).toBe('결과');
    expect(firstLine('- 항목 하나\n- 둘')).toBe('항목 하나');
    expect(firstLine('   ')).toBe('');
  });
});

describe('selectPush (trigger rules)', () => {
  it('a finished turn → session title + first line, one tag per session', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: true, text: '\n고쳤습니다.\n자세한 내용…', badge: null, errorText: null }, titleOf);
    expect(p).toEqual({ kind: 'turn', title: '로그인 버그 고치기', body: '완료 · 고쳤습니다.', sessionId: 's1', tag: 'turn-s1' });
  });

  it('a failed turn says so with the error line', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: false, text: '', badge: null, errorText: '한도 도달\nstack' }, titleOf);
    expect(p?.body).toBe('실패 · 한도 도달');
  });

  it('a waiting permission card and question card', () => {
    const perm = selectPush({
      type: 'permission_request', ...scope, requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf x' }, title: 'Run rm -rf x', decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null,
    } as ServerMessage, titleOf);
    expect(perm).toMatchObject({ kind: 'permission', body: '권한 요청 · Bash: Run rm -rf x', tag: 'ask-r1', sessionId: 's1' });
    const q = selectPush({ type: 'question_request', ...scope, requestId: 'r2', questions: [{ question: '어느 색?', header: '색', options: [], multiSelect: false }] } as unknown as ServerMessage, titleOf);
    expect(q).toMatchObject({ kind: 'question', body: '질문 · 어느 색?', tag: 'ask-r2' });
  });

  it('a background task that settled', () => {
    expect(selectPush({ type: 'task_done', ...scope, status: 'completed', summary: '빌드 끝' }, titleOf)).toMatchObject({ kind: 'task', body: '백그라운드 작업 완료 · 빌드 끝' });
    expect(selectPush({ type: 'task_done', ...scope, status: 'failed', summary: '' }, titleOf)?.body).toBe('백그라운드 작업 실패');
  });

  it('a new session without an id falls back to the folder name', () => {
    const p = selectPush({ type: 'turn_result', turnId: 't9', sessionId: null, cwd: '/Users/alice/dev/proj', ok: true, text: 'ok', badge: null, errorText: null }, titleOf);
    expect(p).toMatchObject({ title: 'proj', tag: 'turn-t9', sessionId: null });
  });

  it('everything else is not a push', () => {
    const none: ServerMessage[] = [
      { type: 'delta', ...scope, text: 'x' },
      { type: 'tool_call', ...scope, toolUseId: 'u', name: 'Read', input: {} },
      { type: 'turn_notice', ...scope, message: 'n' },
      { type: 'permission_resolved', requestId: 'r1', decision: 'once' },
      { type: 'question_resolved', requestId: 'r2', answers: null },
      { type: 'error', turnId: null, message: 'e' },
    ];
    for (const m of none) expect(selectPush(m, titleOf)).toBeNull();
  });

  it('clips long titles and bodies', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: true, text: 'x'.repeat(500), badge: null, errorText: null }, () => 'y'.repeat(200));
    expect(p!.title.length).toBeLessThanOrEqual(60);
    expect(p!.body.length).toBeLessThanOrEqual(140);
  });
});

describe('PushNotifier (mock sender)', () => {
  const setup = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-notifier-'));
    const store = new SubscriptionStore(path.join(dir, 'subs.json'));
    await store.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/live', keys: { p256dh: 'P', auth: 'A' } });
    await store.add({ endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'P', auth: 'A' } });
    const calls: { endpoint: string; payload: unknown; opts: unknown }[] = [];
    const send: PushSender = async (sub, payload, opts) => {
      calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Received unexpected response code'), { statusCode: 410 });
    };
    const n = new PushNotifier({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, subject: 'https://x.ts.net', titleOf, send });
    return { store, calls, n };
  };

  it('notify() sends selected events to every device and forgets 404/410 subscriptions', async () => {
    const { store, calls, n } = await setup();
    n.notify({ type: 'delta', ...scope, text: 'x' });
    expect(calls).toHaveLength(0);
    const r = await n.sendAll({ kind: 'turn', title: 't', body: 'b', sessionId: 's1', tag: 'turn-s1' });
    expect(r).toEqual({ sent: 1, removed: 1 });
    expect(calls.map((c) => c.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/live', 'https://web.push.apple.com/gone']);
    expect(store.list().map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/live']);
  });

  it('permission/question pushes are high urgency with a short TTL', async () => {
    const { calls, n } = await setup();
    n.notify({ type: 'question_request', ...scope, requestId: 'r', questions: [{ question: 'q?' }] } as unknown as ServerMessage);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]!.opts).toEqual({ TTL: 1800, urgency: 'high' });
    expect(calls[0]!.payload).toMatchObject({ kind: 'question', sessionId: 's1' });
  });

  it('a failed delivery is logged by push host only, never the endpoint path or keys', async () => {
    const { store } = await setup();
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    try {
      const n = new PushNotifier({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, subject: 's', titleOf, send: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); } });
      expect(await n.sendTo('https://fcm.googleapis.com/fcm/send/live', { kind: 'test', title: 'deck', body: 'b', sessionId: null, tag: 'test' })).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(logged.join('\n')).toContain('fcm.googleapis.com');
    expect(logged.join('\n')).not.toContain('/fcm/send/live');
    expect(logged.join('\n')).not.toContain('priv');
    expect(store.list()).toHaveLength(2);
  });
});
