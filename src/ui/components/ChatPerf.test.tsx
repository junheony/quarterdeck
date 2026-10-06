// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatItem } from '../state';
import { Chat, type ChatProps } from './Chat';

// Counts markdown renders (= parses): typing in the composer must not re-render the transcript.
const md = vi.hoisted(() => ({ renders: 0 }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => { md.renders++; return <p>{children}</p>; } }));

Element.prototype.scrollIntoView = () => {};

const answer = (i: number): Extract<ChatItem, { kind: 'assistant' }> => ({ kind: 'assistant', turnId: null, text: `answer **${i}**`, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
const transcript: ChatItem[] = Array.from({ length: 40 }, (_, i) => [{ kind: 'user', text: `q${i}` } as ChatItem, answer(i)]).flat();

function props(items: ChatItem[]): ChatProps {
  const noop = () => {};
  return { items, pending: [], questions: [], activeTurnId: null, busy: false, title: 't', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: null, sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: noop, onInterrupt: noop, onDecide: noop, onAnswer: noop, onModel: noop, onEffort: noop, onEngine: noop, onSandbox: noop, onAttach: noop, onUnattach: noop };
}

describe('Chat render cost', () => {
  afterEach(() => { cleanup(); md.renders = 0; });

  it('keystrokes in the composer do not re-render the transcript markdown', () => {
    render(<Chat {...props(transcript)} />);
    expect(md.renders).toBe(40);
    const ta = screen.getByLabelText('메시지');
    for (const v of ['안', '안녕', '안녕하', 'hello @', 'hello /x']) fireEvent.change(ta, { target: { value: v } });
    expect((ta as HTMLTextAreaElement).value).toBe('hello /x');
    expect(md.renders).toBe(40);
  });

  it('a streaming delta re-renders only the item that changed', () => {
    const live: ChatItem = { ...answer(99), text: 'part', streaming: true };
    const { rerender } = render(<Chat {...props([...transcript, live])} />);
    md.renders = 0;
    rerender(<Chat {...props([...transcript, { ...live, text: 'part two' }])} />);
    expect(md.renders).toBe(1);
  });
});
