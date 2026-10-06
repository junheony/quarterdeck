// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';

Element.prototype.scrollIntoView = () => {};

const base = (extra: Partial<ChatProps> = {}) => (
  <Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={() => {}} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />
);

describe('composer pills (Claude parity)', () => {
  afterEach(() => { cleanup(); delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition; });

  it('reads + · model pill (model + effort) · 계정 · 권한 pill · mic · send, in tab order', () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = vi.fn();
    render(base({ accountPin: null, account: 'a', onAccountPin: () => {}, permMode: 'bypassPermissions', onPermMode: () => {} }));
    const attach = screen.getByRole('button', { name: '첨부' });
    const model = screen.getByRole('button', { name: '모델: Opus 5.5 · 높음' });
    expect(model.textContent).toContain('Opus 5.5 높음');
    const sec = screen.getByRole('group', { name: '계정 · 권한' });
    const account = within(sec).getByRole('button', { name: /^계정:/ });
    const perm = within(sec).getByTestId('perm-select');
    const mic = screen.getByRole('button', { name: '음성 받아쓰기' });
    const send = screen.getByRole('button', { name: '보내기' });
    const order = [attach, model, account, perm, mic, send];
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, select'));
    const idx = order.map((el) => all.indexOf(el));
    expect(idx.every((n) => n >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(send.className).toBe('send');
  });

  it('the auto-approve control stays reachable: changing it in the secondary pill calls onPermMode', () => {
    const onPermMode = vi.fn();
    render(base({ permMode: 'default', onPermMode }));
    const sec = screen.getByRole('group', { name: '계정 · 권한' });
    fireEvent.change(within(sec).getByTestId('perm-select'), { target: { value: 'bypassPermissions' } });
    expect(onPermMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('no account / permission controls → no empty secondary pill; no dictation support → no mic', () => {
    render(base());
    expect(screen.queryByRole('group', { name: '계정 · 권한' })).toBeNull();
    expect(screen.queryByRole('button', { name: '음성 받아쓰기' })).toBeNull();
  });

  it('while running, the round send becomes a round stop', () => {
    const onInterrupt = vi.fn();
    render(base({ busy: true, activeTurnId: 't1', onInterrupt }));
    const stop = document.querySelector<HTMLButtonElement>('.composer-send .send')!;
    expect(within(stop).getByText('중단')).toBeTruthy();
    expect(stop.className).toBe('send stop');
    fireEvent.click(stop);
    expect(onInterrupt).toHaveBeenCalled();
  });
});
