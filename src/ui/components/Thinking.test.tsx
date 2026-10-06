// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MessageView } from './MessageView';
import { fromTranscript, initialState, reducer, type ChatItem } from '../state';

const base: Extract<ChatItem, { kind: 'assistant' }> = { kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] };

describe('thinking render', () => {
  afterEach(cleanup);

  it('shows a collapsed "N초 동안 생각함" disclosure with the text', () => {
    const { container, getByText } = render(<MessageView item={{ ...base, thinking: { text: '먼저 확인', redacted: false, startedAt: 0, ms: 8200 } }} />);
    const d = container.querySelector('details.thinking') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(getByText('8초 동안 생각함')).toBeTruthy();
    expect(d.textContent).toContain('먼저 확인');
  });

  it('redacted thinking shows only the placeholder', () => {
    const { container } = render(<MessageView item={{ ...base, thinking: { text: '', redacted: true, startedAt: null, ms: null } }} />);
    expect(container.querySelector('.thinking-body')?.textContent).toBe('(암호화된 생각)');
  });

  it('history: transcript thinking becomes an item with thinking', () => {
    const items: ChatItem[] = fromTranscript([{ kind: 'assistant', text: 'a', model: null, toolCalls: [], ts: null, thinking: 'hm' }]);
    expect(items[0]).toMatchObject({ thinking: { text: 'hm', redacted: false } });
  });

  it('highlights fenced code and keeps the copy button + language label', async () => {
    const { container } = render(<MessageView item={{ ...base, text: '```ts\nconst a = 1;\n```' }} />);
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
    expect(container.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(container.querySelector('button[aria-label="코드 복사"]')).not.toBeNull();
  });

  it('renders math with KaTeX', async () => {
    const { container } = render(<MessageView item={{ ...base, text: '식 $$x^2$$ 입니다' }} />);
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
  });
});

describe('dollar signs', () => {
  afterEach(cleanup);
  it('prices and tickers stay plain text', async () => {
    for (const text of ['$5 and $10', '$BTC $ETH']) {
      const { container } = render(<MessageView item={{ ...base, text }} />);
      await new Promise((r) => setTimeout(r, 50));
      expect(container.querySelector('.katex')).toBeNull();
      expect(container.querySelector('.markdown')?.textContent).toBe(text);
      cleanup();
    }
  });
});

describe('thinking reducer', () => {
  it('accumulates thinking live and fixes elapsed time at the first reply text', () => {
    const scope = { turnId: 'T', sessionId: 's', cwd: '/w' };
    const started = reducer(reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' }), { type: 'server', msg: { type: 'turn_started', ...scope, account: 'a', model: 'opus', reason: 'r', attempt: 0 } });
    const s = [{ type: 'thinking', ...scope, text: '' }, { type: 'thinking', ...scope, text: '생각' }, { type: 'delta', ...scope, text: 'hi' }].reduce((st, msg) => reducer(st, { type: 'server', msg } as never), started);
    const it = s.panes[0]!.items.at(-1) as Extract<ChatItem, { kind: 'assistant' }>;
    expect(it.thinking).toMatchObject({ text: '생각', redacted: false });
    expect(it.thinking?.ms).not.toBeNull();
    expect(it.text).toBe('hi');
  });
});
