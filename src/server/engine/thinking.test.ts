import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseTranscript } from '../sessions/transcript';
import { mapSdkMessage } from './ClaudeEngine';
import { StreamRedactor, redactSecrets } from './redact';

const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event }) as unknown as SDKMessage;
const L = (o: unknown) => JSON.stringify(o);

// A real stall (quadratic rescans) takes many seconds; 1s flaked under heavy machine load.
const STALL_MS = 5000;

describe('thinking: stream', () => {
  it('maps thinking block start / deltas / redacted blocks', () => {
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))).toEqual([{ kind: 'thinking', text: '' }]);
    expect(mapSdkMessage(ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '음…' } }))).toEqual([{ kind: 'thinking', text: '음…' }]);
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }))).toEqual([{ kind: 'thinking', text: '', redacted: true }]);
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }))).toEqual([]);
  });
});

describe('thinking: transcript', () => {
  const asst = (content: unknown[]) => L({ type: 'assistant', timestamp: 't', message: { id: 'm1', model: 'x', content } });
  it('collects thinking text across chunks of one message', () => {
    const m = parseTranscript([asst([{ type: 'thinking', thinking: 'a' }]), asst([{ type: 'thinking', thinking: 'b' }, { type: 'text', text: 'hi' }])].join('\n'));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'assistant', text: 'hi', thinking: 'a\n\nb' });
  });
  it('thinking loaded from a transcript is redacted like the live stream (whole block)', () => {
    const key = 'sk-ant-api03-AbCdEf0123456789_xyzQRST';
    const m = parseTranscript([asst([{ type: 'thinking', thinking: `키는 ${key} 이고 token: zz9yy8xx7ww6` }]), asst([{ type: 'thinking', thinking: 'Bearer abcdefgh12345678' }, { type: 'text', text: 'hi' }])].join('\n'));
    expect(m[0]).toMatchObject({ thinking: `${redactSecrets(`키는 ${key} 이고 token: zz9yy8xx7ww6`)}\n\n${redactSecrets('Bearer abcdefgh12345678')}` });
    const t = (m[0] as { thinking: string }).thinking;
    expect(t).not.toContain(key);
    expect(t).not.toContain('zz9yy8xx7ww6');
    expect(t).not.toContain('abcdefgh12345678');
  });
  it('marks redacted / empty-text thinking', () => {
    expect(parseTranscript(asst([{ type: 'redacted_thinking', data: 'zz' }, { type: 'text', text: 'hi' }]))[0]).toMatchObject({ thinkingRedacted: true });
    expect(parseTranscript(asst([{ type: 'thinking', thinking: '', signature: 's' }]))[0]).toMatchObject({ thinkingRedacted: true });
  });
  it('an empty thinking block with no signature shows nothing (not "encrypted")', () => {
    const e = parseTranscript(asst([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }]))[0];
    expect(e).not.toHaveProperty('thinkingRedacted');
    expect(e).not.toHaveProperty('thinking');
  });
});

describe('thinking: streaming redaction across chunk boundaries', () => {
  const SECRETS = [
    'sk-ant-api03-AbCdEf0123456789_xyz-QRST',
    'Bearer abcdefgh12345678.ijkl',
    'api_key="s3cr3tvalue99"',
    'token: zz9yy8xx7ww6',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlXzEyMw',
    'deadbeef0123456789abcdef0123456789abcdef01',
    'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd',
  ];
  const run = (chunks: string[]) => {
    const r = new StreamRedactor();
    const out = chunks.map((c) => r.push(c));
    return { out, joined: out.join('') + r.flush() };
  };

  it('a secret split at every offset across two deltas never appears in the output', () => {
    for (const s of SECRETS) {
      for (const pre of ['', '먼저 확인: ', 'look at ']) {
        const whole = `${pre}${s} 그리고 계속`;
        for (let i = 0; i <= whole.length; i++) {
          const { out, joined } = run([whole.slice(0, i), whole.slice(i)]);
          expect(joined, `${s} @${i}`).toBe(redactSecrets(whole));
          expect(joined).not.toContain(s.slice(-8));
          for (const o of out) expect(o).not.toContain(s.slice(-8));
        }
      }
    }
  });

  it('random multi-chunk splits: joined output equals redaction of the whole text', () => {
    const whole = `생각 중… ${SECRETS.join(' 그리고 ')} 끝. 일본語テキストは空白なし`;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const chunks: string[] = [];
      for (let i = 0; i < whole.length;) { const k = 1 + Math.floor(rnd() * 12); chunks.push(whole.slice(i, i + k)); i += k; }
      expect(run(chunks).joined).toBe(redactSecrets(whole));
    }
  });

  it('plain prose is emitted promptly (only the unfinished word is held)', () => {
    const r = new StreamRedactor();
    expect(r.push('hello wor')).toBe('hello ');
    expect(r.push('ld, and ')).toBe('world, and ');
    expect(r.push('日本語のテキスト')).toBe('日本語のテキスト');
    expect(r.push(' token')).toBe(' ');
    expect(r.push(' was used')).toBe('token was ');
    expect(r.flush()).toBe('used');
    expect(r.flush()).toBe('');
  });

  it('a long unbroken run in tiny deltas does not stall: 4000 × "a-" well under the stall bound, collapsed past the cap', () => {
    const t0 = performance.now();
    const { joined } = run([...Array.from({ length: 4000 }, () => 'a-'), ' 그리고 끝']);
    expect(performance.now() - t0).toBeLessThan(STALL_MS);
    // longer than the held-text cap: the run is collapsed to the marker and the stream carries on
    expect(joined).toBe('[redacted] 그리고 끝');
  });

  it('under the cap, many tiny deltas stay fast and equal redaction of the whole text', () => {
    const runText = 'a-'.repeat(1500);
    const prose = Array.from({ length: 400 }, (_, i) => `word${i} ${i % 50 === 0 ? SECRETS[i % SECRETS.length] : 'x'} `).join('');
    for (const whole of [runText, prose, `${runText} ${prose}`]) {
      const t0 = performance.now();
      const chunks = whole.match(/[\s\S]{1,2}/g)!;
      expect(run(chunks).joined).toBe(redactSecrets(whole));
      expect(performance.now() - t0).toBeLessThan(STALL_MS);
    }
  });

  it('a secret run longer than the cap leaks no fragment, whatever the delta size', () => {
    const hex = 'deadbeef0123456789'.repeat(400); // 7200 hex-ish chars, one run
    for (const k of [1, 7, 333]) {
      const whole = `키: ${hex} 다음 줄`;
      const chunks: string[] = [];
      for (let i = 0; i < whole.length; i += k) chunks.push(whole.slice(i, i + k));
      const { joined } = run(chunks);
      expect(joined).toBe('키: [redacted] 다음 줄');
    }
  });
});
