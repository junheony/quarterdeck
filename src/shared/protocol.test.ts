import { describe, expect, it } from 'vitest';
import { LEGACY_ACCOUNTS, buildRegistry } from './accounts';
import { ClientMessageSchema, FEATURES, accountInfos } from './protocol';

describe('ClientMessageSchema', () => {
  it('accepts valid messages', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: 'x', cwd: '/w', text: 'hi', model: 'fable' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'permission_response', requestId: 'r', decision: 'session' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'interrupt', turnId: 't' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'open_session', sessionId: 's' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'refresh_index' }).success).toBe(true);
  });

  it('account pin: send.accountPin (a|b|c|null) and set_account_pin', () => {
    const base = { type: 'send', sessionId: null, cwd: '/w', text: 'hi' };
    expect(ClientMessageSchema.safeParse({ ...base, accountPin: 'b' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, accountPin: null }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, accountPin: 'gpt' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'set_account_pin', sessionId: 's', pin: 'a' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'set_account_pin', sessionId: 's', pin: null }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'set_account_pin', sessionId: 's', pin: 'g1' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'set_account_pin', sessionId: '', pin: 'a' }).success).toBe(false);
  });

  it('send.clientRef is optional, 1..64 chars', () => {
    const base = { type: 'send', sessionId: null, cwd: '/w', text: 'hi' };
    expect(ClientMessageSchema.safeParse({ ...base, clientRef: 'p0-1' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, clientRef: 'r'.repeat(64) }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, clientRef: 'r'.repeat(65) }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, clientRef: '' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, clientRef: 7 }).success).toBe(false);
  });

  it('rejects unknown types, haiku, empty text, and non-objects', () => {
    expect(ClientMessageSchema.safeParse({ type: 'exec', cmd: 'rm' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'haiku' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: '' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse('send').success).toBe(false);
  });

  it('accepts engine/sandbox/attachments/codex models on send, question_response and close_session', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', engine: 'auto', sandbox: 'workspace-write', model: 'gpt-6-astra', attachments: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'question_response', requestId: 'q1', answers: { 'Which color?': 'blue' } }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'close_session', sessionId: 's' }).success).toBe(true);
  });

  it('effort: accepts the four allowlisted levels, rejects anything else', () => {
    const send = (effort: unknown) => ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'opus', effort }).success;
    for (const e of ['low', 'medium', 'high', 'xhigh']) expect(send(e)).toBe(true);
    for (const e of ['max', 'ultra', 'HIGH', '', 3, 'high" -c x="y']) expect(send(e)).toBe(false);
  });
  it('rejects luna, gpt-5.6-sol, bad attachment ids, more than 8 attachments, unknown engines', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'gpt-5.6-luna' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'gpt-5.6-sol' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', attachments: ['../etc/passwd'] }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', attachments: Array(9).fill('11111111-1111-4111-8111-111111111111') }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', engine: 'mistral' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', engine: 'gemini', model: 'gemini-flash' }).success).toBe(true);
  });
});

describe('ClientMessageSchema: handoff', () => {
  it('send accepts handoff (boolean) and handoffFrom (1..200 chars)', () => {
    const base = { type: 'send', sessionId: 's', cwd: '/w', text: 'x' };
    expect(ClientMessageSchema.safeParse({ ...base, handoff: true }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, sessionId: null, handoffFrom: 'abc' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...base, handoff: 'yes' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, handoffFrom: '' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, handoffFrom: 'a'.repeat(201) }).success).toBe(false);
  });
});

describe('account ids on the wire', () => {
  const send = { type: 'send', sessionId: null, cwd: '/w', text: 'hi' };
  const pin = (p: unknown) => ClientMessageSchema.safeParse({ type: 'set_account_pin', sessionId: 's', pin: p }).success;

  it('any id of the configured shape passes (a fourth account, a named one): which exist is checked by the server', () => {
    for (const id of ['d', 'work', 'team-2', 'x_1', '9', 'a'.repeat(16)]) {
      expect(ClientMessageSchema.safeParse({ ...send, accountPin: id }).success).toBe(true);
      expect(pin(id)).toBe(true);
    }
  });

  it('a malformed id is refused by the schema', () => {
    for (const id of ['', 'D', 'Work', '-a', '_a', 'a b', 'a/b', '../x', 'a'.repeat(17), 'é', 1, {}, ['a']]) {
      expect(ClientMessageSchema.safeParse({ ...send, accountPin: id }).success).toBe(false);
      expect(pin(id)).toBe(false);
    }
  });

  it('the other seats and reserved names are not account ids', () => {
    for (const id of ['gpt', 'g1', 'g2', 'codex', 'all', 'constructor']) expect(pin(id)).toBe(false);
  });

  it('FEATURES names accounts; accountInfos lists every configured account in order with label, home and retired', () => {
    expect(FEATURES).toContain('accounts');
    const reg = buildRegistry({ version: 1, accounts: [{ id: 'b', label: 'Work' }, { id: 'a' }, { id: 'old', retired: true }, { id: 'd' }], home: 'b' }, { homeDir: '/tmp/none' });
    expect(accountInfos(reg)).toEqual([
      { id: 'b', label: 'Work', home: true, retired: false },
      { id: 'a', label: 'A', home: false, retired: false },
      { id: 'old', label: 'OLD', home: false, retired: true },
      { id: 'd', label: 'D', home: false, retired: false },
    ]);
    expect(accountInfos(LEGACY_ACCOUNTS).map((a) => [a.id, a.label, a.home, a.retired])).toEqual([['a', 'A', true, false], ['b', 'B', false, false], ['c', 'C', false, false]]);
  });
});
