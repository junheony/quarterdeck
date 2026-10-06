// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { WARM_MS, type ContextInfo } from '../context';
import { ContextGauge, ContextHint } from './ContextGauge';

const info = (cacheReadTokens: number, over: Partial<ContextInfo> = {}): ContextInfo =>
  ({ usage: { inputTokens: 2_000, cacheReadTokens, cacheCreationTokens: 10_000 }, window: 1_000_000, at: Date.now(), model: 'opus', account: 'b', ...over });

describe('ContextGauge', () => {
  afterEach(cleanup);

  it('renders nothing without a context', () => {
    const { container } = render(<ContextGauge info={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the size with the Desktop-style tooltip, and the label on tap', () => {
    const { getByTestId, container } = render(<ContextGauge info={info(300_000)} />);
    const g = getByTestId('context-gauge');
    expect(g.getAttribute('title')).toBe('컨텍스트 312k / 1M · 캐시 적중 96%');
    expect(g.textContent).toBe('312k');
    expect(g.classList.contains('long')).toBe(true);
    expect(container.querySelector('.ctx-pop')).toBeNull();
    fireEvent.click(g);
    expect(container.querySelector('.ctx-pop')?.textContent).toBe('컨텍스트 312k / 1M · 캐시 적중 96%');
  });

  it('a small context is not flagged', () => {
    const { getByTestId } = render(<ContextGauge info={info(50_000)} />);
    expect(getByTestId('context-gauge').classList.contains('ok')).toBe(true);
  });
});

describe('ContextHint', () => {
  afterEach(cleanup);

  it('long session → handoff hint; idle → cache-expired note; otherwise nothing', () => {
    expect(render(<ContextHint info={info(50_000)} />).queryByTestId('context-hint')).toBeNull();
    cleanup();
    expect(render(<ContextHint info={info(400_000)} />).getByTestId('context-hint').textContent).toContain('새 세션으로 넘기면');
    cleanup();
    expect(render(<ContextHint info={info(50_000, { at: Date.now() - WARM_MS - 60_000 })} />).getByTestId('context-hint').textContent).toBe('캐시 만료 · 이번 턴은 전체 다시 읽기');
  });
});

describe('새 세션으로 이어가기 button', () => {
  afterEach(cleanup);

  it('the gauge popover offers it when onHandoff is given; mousedown does not blur the gauge, click hands off and closes', () => {
    let n = 0;
    const { getByTestId, container } = render(<ContextGauge info={info(300_000)} onHandoff={() => { n++; }} />);
    fireEvent.click(getByTestId('context-gauge'));
    const btn = getByTestId('handoff-btn');
    expect(btn.textContent).toBe('새 세션으로 이어가기');
    expect(fireEvent.mouseDown(btn)).toBe(false); // default prevented: focus stays, the popover is not closed by blur
    fireEvent.click(btn);
    expect(n).toBe(1);
    expect(container.querySelector('.ctx-pop')).toBeNull();
    cleanup();
    render(<ContextGauge info={info(300_000)} />);
    fireEvent.click(document.querySelector('[data-testid="context-gauge"]')!);
    expect(document.querySelector('[data-testid="handoff-btn"]')).toBeNull();
  });

  it('the long-session hint carries the button; other hints and a missing onHandoff do not', () => {
    let n = 0;
    const long = render(<ContextHint info={info(300_000)} onHandoff={() => { n++; }} />);
    fireEvent.click(long.getByTestId('handoff-btn'));
    expect(n).toBe(1);
    cleanup();
    expect(render(<ContextHint info={info(300_000)} />).queryByTestId('handoff-btn')).toBeNull();
    cleanup();
    const cold = render(<ContextHint info={info(50_000, { at: Date.now() - WARM_MS - 60_000 })} onHandoff={() => {}} />);
    expect(cold.queryByTestId('context-hint')).not.toBeNull();
    expect(cold.queryByTestId('handoff-btn')).toBeNull();
  });
});
