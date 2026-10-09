// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueueChips } from './QueueChips';
import type { QueueItem } from '../state';

const held = { id: 'q1', text: 'hello', attachments: [], restart: 'hold' } as unknown as QueueItem;
const chips = (connected?: boolean) => render(<QueueChips queue={[held]} paused={false} onEdit={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onResume={vi.fn()} {...(connected === undefined ? {} : { connected })} />);

describe('QueueChips hold label', () => {
  afterEach(cleanup);
  it('connected: 재시작 뒤 전송', () => {
    chips(true);
    expect(screen.getByText(/재시작 뒤 전송/)).toBeTruthy();
    expect(screen.queryByText(/연결되면 전송/)).toBeNull();
  });
  it('disconnected: 연결되면 전송', () => {
    chips(false);
    expect(screen.getByText(/연결되면 전송/)).toBeTruthy();
    expect(screen.queryByText(/재시작 뒤 전송/)).toBeNull();
  });
});
