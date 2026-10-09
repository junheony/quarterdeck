// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CARD_PENDING_RESET_MS, PermissionCard } from './PermissionCard';
import type { PendingPermission } from '../state';

const bashReq: PendingPermission = { turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };

describe('PermissionCard', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the tool and input and emits the three decisions', () => {
    const onDecide = vi.fn();
    const rmReq: PendingPermission = { turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };
    const { rerender } = render(<PermissionCard req={rmReq} onDecide={onDecide} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    expect(screen.getByTestId('permission-scope').textContent).toContain('/w/proj');
    expect(screen.getByTestId('permission-scope').textContent).toContain('s1');
    // A tap locks the card until the request changes, so each decision gets its own request id.
    fireEvent.click(screen.getByText('허용 1회'));
    rerender(<PermissionCard req={{ ...rmReq, requestId: 'r2' }} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('이 세션 동안 허용'));
    rerender(<PermissionCard req={{ ...rmReq, requestId: 'r3' }} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('거부'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once'], ['r2', 'session'], ['r3', 'deny']]);
  });

  it('shows the SDK title, reason and blocked path; hides 이 세션 when not offered; defaultToNo focuses 거부', () => {
    render(<PermissionCard req={{ turnId: 't', sessionId: null, cwd: '/w', requestId: 'r2', toolName: 'Bash', input: {}, title: 'Claude wants to run rm', decisionReason: 'dangerous', blockedPath: '/etc/hosts', defaultToNo: true, allowSession: false, sessionLabel: null }} onDecide={() => {}} />);
    expect(screen.getByText('Claude wants to run rm')).toBeTruthy();
    expect(screen.getByText(/dangerous/)).toBeTruthy();
    expect(screen.getByText(/\/etc\/hosts/)).toBeTruthy();
    expect(screen.queryByText('이 세션 동안 허용')).toBeNull();
    expect(screen.queryByTestId('session-rule')).toBeNull();
    expect(document.activeElement?.textContent).toBe('거부');
  });

  it('keeps a long session rule out of the button: short label, full rule in the tooltip and a wrapping line below', () => {
    const long = `git -C /Users/alice/Documents/작업/acme-worktree log --oneline --decorate --graph --all -n 200 ${'x'.repeat(300)}`;
    const label = `이 세션 동안 \`Bash(${long})\` 허용`;
    render(<PermissionCard req={{ turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'r3', toolName: 'Bash', input: { command: long }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: label }} onDecide={() => {}} />);
    const btn = screen.getByRole('button', { name: '이 세션 동안 허용' });
    expect(btn.textContent).toBe('이 세션 동안 허용');
    expect(btn.getAttribute('title')).toBe(label);
    expect(btn.className).toContain('session-allow');
    const rule = screen.getByTestId('session-rule');
    expect(rule.querySelector('code')?.textContent).toBe(`\`Bash(${long})\``);
    // All three decisions share one actions row (wraps + right-aligns via CSS).
    const actions = btn.parentElement!;
    expect(actions.className).toBe('permission-actions');
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['거부', '이 세션 동안 허용', '허용 1회']);
  });

  it('clicking 허용 1회 disables the buttons and shows 보내는 중…', () => {
    const onDecide = vi.fn();
    render(<PermissionCard req={bashReq} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('허용 1회'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once']]);
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('보내는 중…');
    expect(buttons[0]!.parentElement!.className).toBe('permission-actions sending');
    // A second tap on the disabled button must not send again.
    fireEvent.click(screen.getByText('허용 1회'));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('the buttons come back after 8 s without a resolution', () => {
    vi.useFakeTimers();
    render(<PermissionCard req={bashReq} onDecide={() => {}} />);
    fireEvent.click(screen.getByText('거부'));
    act(() => { vi.advanceTimersByTime(CARD_PENDING_RESET_MS - 1); });
    expect((screen.getByText('거부') as HTMLButtonElement).disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect((screen.getByText('거부') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a new requestId resets the pending state', () => {
    const { rerender } = render(<PermissionCard req={bashReq} onDecide={() => {}} />);
    fireEvent.click(screen.getByText('허용 1회'));
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<PermissionCard req={{ ...bashReq, requestId: 'r9' }} onDecide={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByText('허용 1회') as HTMLButtonElement).disabled).toBe(false);
  });
});
