// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { distanceFromBottom, nextStick, STICK_THRESHOLD } from './stickToBottom';
import { Chat, type ChatProps } from './components/Chat';
import type { ChatItem } from './state';

describe('nextStick', () => {
  const at = (top: number, height = 1000, client = 400) => ({ top, height, client });
  const prev = (top: number, height = 1000) => ({ top, height });

  it('at the bottom is attached, whatever caused the scroll (our follow, a clamp on shrink)', () => {
    expect(distanceFromBottom(at(600))).toBe(0);
    expect(nextStick(false, prev(100), at(600))).toBe(true);
    expect(nextStick(false, prev(800, 1200), at(599))).toBe(true);
  });

  it('any upward move detaches, even a few px inside the threshold', () => {
    expect(nextStick(true, prev(600), at(590))).toBe(false);
    expect(nextStick(true, prev(600), at(200))).toBe(false);
    // also while content grew in the same frame
    expect(nextStick(true, prev(600, 1000), at(580, 1100))).toBe(false);
  });

  it('a user scroll down into the threshold re-attaches; a scroll-anchoring shift (height changed) does not', () => {
    expect(nextStick(false, prev(500), at(600 - STICK_THRESHOLD + 10))).toBe(true);
    expect(nextStick(false, prev(300), at(400))).toBe(false);
    expect(nextStick(false, prev(550, 1000), at(600, 1050))).toBe(false);
  });

  it('no movement keeps the current mode', () => {
    expect(nextStick(true, prev(300), at(300))).toBe(true);
    expect(nextStick(false, prev(300), at(300))).toBe(false);
  });
});

// jsdom has no layout: the scroll box is faked on the transcript element.
function fakeBox(el: HTMLElement, box: { height: number; client: number; top: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - box.client)); } });
  return box;
}

const user = (text: string): ChatItem => ({ kind: 'user', text });
const answer = (text: string, streaming = false): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming, error: null, notes: [], attempts: [] });

function props(items: ChatItem[], extra: Partial<ChatProps> = {}): ChatProps {
  const noop = () => {};
  return { items, pending: [], questions: [], activeTurnId: null, busy: false, title: 't', sessionId: 's1', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: null, sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: noop, onInterrupt: noop, onDecide: noop, onAnswer: noop, onModel: noop, onEffort: noop, onEngine: noop, onSandbox: noop, onAttach: noop, onUnattach: noop, ...extra };
}

function setup(items: ChatItem[]) {
  const view = render(<Chat {...props(items)} />);
  const body = view.container.querySelector('.chat-body') as HTMLElement;
  const box = fakeBox(body, { height: 1000, client: 400, top: 0 });
  // Mount: follow to the bottom.
  view.rerender(<Chat {...props([...items])} />);
  return { view, body, box };
}

describe('Chat scroll lock', () => {
  afterEach(cleanup);

  it('follows streaming content while at the bottom', () => {
    const { view, box } = setup([user('q'), answer('a', true)]);
    expect(box.top).toBe(600);
    box.height = 1300;
    view.rerender(<Chat {...props([user('q'), answer('a more', true)])} />);
    expect(box.top).toBe(900);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
  });

  it('scrolling up stops the follow; new content does not move the view and shows 새 메시지; the button re-attaches', () => {
    const { view, body, box } = setup([user('q'), answer('a', true)]);
    fireEvent.wheel(body, { deltaY: -40 });
    box.top = 560; // within the threshold, still detached: the user asked to move up
    fireEvent.scroll(body);
    expect(screen.getByTestId('jump-bottom').textContent).not.toContain('새 메시지');
    box.height = 1400;
    view.rerender(<Chat {...props([user('q'), answer('a much more', true)])} />);
    expect(box.top).toBe(560);
    const jump = screen.getByTestId('jump-bottom');
    expect(jump.textContent).toContain('새 메시지');
    fireEvent.click(jump);
    expect(box.top).toBe(1000);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
    box.height = 1500;
    view.rerender(<Chat {...props([user('q'), answer('a much more!', true)])} />);
    expect(box.top).toBe(1100);
  });

  it('a scrollbar drag (no wheel) up detaches; scrolling back to the bottom re-attaches', () => {
    const { view, body, box } = setup([user('q'), answer('a', true)]);
    box.top = 300;
    fireEvent.scroll(body);
    box.height = 1200;
    view.rerender(<Chat {...props([user('q'), answer('ab', true)])} />);
    expect(box.top).toBe(300);
    box.top = 800;
    fireEvent.scroll(body);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
    box.height = 1300;
    view.rerender(<Chat {...props([user('q'), answer('abc', true)])} />);
    expect(box.top).toBe(900);
  });

  it('a touch drag down (content moving up) detaches before the scroll lands', () => {
    const { view, body, box } = setup([user('q'), answer('a', true)]);
    fireEvent.touchStart(body, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(body, { touches: [{ clientY: 140 }] });
    box.height = 1200;
    view.rerender(<Chat {...props([user('q'), answer('ab', true)])} />);
    expect(box.top).toBe(600);
    expect(screen.getByTestId('jump-bottom')).toBeTruthy();
  });

  it('our own follow scroll does not detach, and sending re-attaches', () => {
    const onSend = vi.fn();
    const { view, body, box } = setup([user('q'), answer('a')]);
    box.height = 1200;
    view.rerender(<Chat {...props([user('q'), answer('ab')])} />);
    fireEvent.scroll(body); // the event caused by the follow
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
    box.top = 100;
    fireEvent.scroll(body);
    expect(screen.getByTestId('jump-bottom')).toBeTruthy();
    view.rerender(<Chat {...props([user('q'), answer('ab')], { onSend })} />);
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: 'next' } });
    act(() => { fireEvent.click(screen.getByTitle('보내기 (Enter)')); });
    expect(onSend).toHaveBeenCalledWith('next');
    expect(box.top).toBe(800);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
  });

  it('switching the pane to another session opens at the bottom', () => {
    const { view, body, box } = setup([user('q'), answer('a')]);
    box.top = 0;
    fireEvent.scroll(body);
    box.height = 2000;
    view.rerender(<Chat {...props([user('other'), answer('b')], { sessionId: 's2' })} />);
    expect(box.top).toBe(1600);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
  });
});
