import webpush from 'web-push';
import type { ServerMessage } from '../../shared/protocol';
import type { PushSub, SubscriptionStore } from './SubscriptionStore';
import type { VapidKeys } from './vapid';

export type PushKind = 'turn' | 'permission' | 'question' | 'task' | 'test';

/** What the service worker receives (sw.js `push` handler). */
export type PushPayload = { kind: PushKind; title: string; body: string; sessionId: string | null; tag: string };

export type PushSendOptions = { TTL: number; urgency: 'normal' | 'high' };
export type PushSender = (sub: PushSub, payload: string, opts: PushSendOptions) => Promise<unknown>;

const TITLE_MAX = 60;
const BODY_MAX = 140;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First non-empty line, markdown heading/bullet marks dropped. */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Which server events become a push (pure, so the trigger rules are testable without a sender):
 * a finished turn, a waiting permission or question card, a background task that settled.
 * Everything else (deltas, tool calls, resolutions, notices) → null.
 * Whether the user is already looking is decided by the service worker (a focused deck window suppresses it).
 */
export function selectPush(msg: ServerMessage, titleOf: (sessionId: string | null, cwd: string) => string): PushPayload | null {
  const head = (sessionId: string | null, cwd: string) => clip(titleOf(sessionId, cwd) || 'deck', TITLE_MAX);
  switch (msg.type) {
    case 'turn_result': {
      const line = firstLine(msg.ok ? msg.text : (msg.errorText ?? msg.text));
      const body = msg.ok ? `완료${line ? ` · ${line}` : ''}` : `실패${line ? ` · ${line}` : ''}`;
      return { kind: 'turn', title: head(msg.sessionId, msg.cwd), body: clip(body, BODY_MAX), sessionId: msg.sessionId, tag: `turn-${msg.sessionId ?? msg.turnId}` };
    }
    case 'permission_request': {
      const what = msg.title ? `${msg.toolName}: ${firstLine(msg.title)}` : msg.toolName;
      return { kind: 'permission', title: head(msg.sessionId, msg.cwd), body: clip(`권한 요청 · ${what}`, BODY_MAX), sessionId: msg.sessionId, tag: `ask-${msg.requestId}` };
    }
    case 'question_request': {
      const q = firstLine(msg.questions[0]?.question ?? '');
      return { kind: 'question', title: head(msg.sessionId, msg.cwd), body: clip(`질문 · ${q || '답을 기다립니다'}`, BODY_MAX), sessionId: msg.sessionId, tag: `ask-${msg.requestId}` };
    }
    case 'task_done': {
      const label = msg.status === 'completed' ? '백그라운드 작업 완료' : msg.status === 'failed' ? '백그라운드 작업 실패' : '백그라운드 작업 중지';
      const line = firstLine(msg.summary);
      return { kind: 'task', title: head(msg.sessionId, msg.cwd), body: clip(`${label}${line ? ` · ${line}` : ''}`, BODY_MAX), sessionId: msg.sessionId, tag: `task-${msg.sessionId ?? msg.turnId}` };
    }
    default:
      return null;
  }
}

/** Push service host only — the endpoint path is a per-device secret-ish id and stays out of logs. */
function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return '?'; }
}

function statusOf(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : null;
}

export class PushNotifier {
  private readonly send: PushSender;

  constructor(private readonly opts: {
    store: SubscriptionStore;
    vapid: VapidKeys;
    /** VAPID `sub` claim: an https URL or mailto:. */
    subject: string;
    titleOf: (sessionId: string | null, cwd: string) => string;
    send?: PushSender;
  }) {
    this.send = opts.send ?? ((sub, payload, o) => webpush.sendNotification(sub, payload, {
      ...o,
      vapidDetails: { subject: opts.subject, publicKey: opts.vapid.publicKey, privateKey: opts.vapid.privateKey },
    }));
  }

  get publicKey(): string {
    return this.opts.vapid.publicKey;
  }

  /** Fire-and-forget hook for every server event. */
  notify(msg: ServerMessage): void {
    const payload = selectPush(msg, this.opts.titleOf);
    if (payload) void this.sendAll(payload);
  }

  async sendAll(payload: PushPayload): Promise<{ sent: number; removed: number }> {
    const results = await Promise.all(this.opts.store.list().map((sub) => this.deliver(sub, payload)));
    return { sent: results.filter((r) => r === 'ok').length, removed: results.filter((r) => r === 'gone').length };
  }

  /** Test button: only the asking device. false = not subscribed here (or delivery failed). */
  async sendTo(endpoint: string, payload: PushPayload): Promise<boolean> {
    const sub = this.opts.store.list().find((s) => s.endpoint === endpoint);
    return sub ? (await this.deliver(sub, payload)) === 'ok' : false;
  }

  private async deliver(sub: PushSub, payload: PushPayload): Promise<'ok' | 'gone' | 'fail'> {
    const urgent = payload.kind === 'permission' || payload.kind === 'question';
    try {
      await this.send(sub, JSON.stringify(payload), { TTL: urgent ? 30 * 60 : 6 * 3600, urgency: urgent ? 'high' : 'normal' });
      return 'ok';
    } catch (err) {
      const status = statusOf(err);
      // 404/410: the browser dropped this subscription — forget it.
      if (status === 404 || status === 410) {
        await this.opts.store.remove(sub.endpoint).catch(() => {});
        return 'gone';
      }
      console.error(`deck push: 전송 실패 (${hostOf(sub.endpoint)}, ${status ?? (err instanceof Error ? err.message : 'error')})`);
      return 'fail';
    }
  }
}
