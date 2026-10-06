// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsView } from './SettingsView';

const noop = () => {};

describe('SettingsView 권한', () => {
  afterEach(cleanup);

  it('the 새 세션 기본 권한 select shows the default mode and changes it; hidden until the server says', () => {
    const onMode = vi.fn();
    const { rerender } = render(<SettingsView build={null} defaultPermMode={null} onDefaultPermMode={onMode} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByTestId('default-perm-select')).toBeNull();
    rerender(<SettingsView build={null} defaultPermMode="bypassPermissions" onDefaultPermMode={onMode} onOpenUsage={noop} onClose={noop} />);
    const sel = screen.getByTestId('default-perm-select') as HTMLSelectElement;
    expect(sel.value).toBe('bypassPermissions');
    fireEvent.change(sel, { target: { value: 'plan' } });
    expect(onMode).toHaveBeenCalledWith('plan');
  });
});

describe('SettingsView 자동 계정 선택', () => {
  afterEach(cleanup);

  it('two options (고르게 분산 / 리셋 임박 먼저 소진): shows the server value and sends a change; hidden until the server says', () => {
    const onPolicy = vi.fn();
    const { rerender } = render(<SettingsView build={null} routingPolicy={null} onRoutingPolicy={onPolicy} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '자동 계정 선택' })).toBeNull();
    rerender(<SettingsView build={null} routingPolicy="balance" onRoutingPolicy={onPolicy} onOpenUsage={noop} onClose={noop} />);
    const balance = screen.getByRole('button', { name: '고르게 분산' });
    const drain = screen.getByRole('button', { name: '리셋 임박 먼저 소진' });
    expect(balance.getAttribute('aria-pressed')).toBe('true');
    expect(drain.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(drain);
    expect(onPolicy).toHaveBeenCalledWith('drain');
  });
});
