// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../shared/models';
import { ModelPicker } from './ModelPicker';

function setup(extra: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onModel = vi.fn();
  const onEffort = vi.fn();
  render(<ModelPicker models={CLAUDE_MODELS} model="opus" effort="high" onModel={onModel} onEffort={onEffort} {...extra} />);
  return { onModel, onEffort };
}

describe('ModelPicker', () => {
  afterEach(cleanup);

  it('button reads "<exact version> <effort>" (aria-label keeps the ·); closed until clicked', () => {
    setup();
    expect(screen.getByTestId('model-picker').textContent).toContain('Opus 5.5 높음');
    expect(screen.getByTestId('model-picker').getAttribute('aria-label')).toBe('모델: Opus 5.5 · 높음');
    expect(screen.queryByTestId('model-menu')).toBeNull();
    expect(screen.getByTestId('model-picker').getAttribute('aria-expanded')).toBe('false');
  });

  it('lists exact versions with descriptions, checks the current model and effort, and reports picks', () => {
    const { onModel, onEffort } = setup();
    fireEvent.click(screen.getByTestId('model-picker'));
    const menu = within(screen.getByTestId('model-menu'));
    const models = within(menu.getByRole('group', { name: 'Claude' })).getAllByRole('menuitemradio');
    expect(models.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['Sonnet 5.5', 'Opus 5.5', 'Fable 5.1']);
    expect(models.every((b) => (b.querySelector('.mp-desc')?.textContent ?? '').length > 0)).toBe(true);
    expect(models.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    // A single engine: no section header for it, but the effort section is headed.
    expect(menu.queryByText('Claude')).toBeNull();
    const effort = within(menu.getByRole('group', { name: '추론 수준' }));
    expect(effort.getAllByRole('menuitemradio').map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([['낮음', 'false'], ['중간', 'false'], ['높음', 'true'], ['엑스트라', 'false']]);
    fireEvent.click(menu.getByText('Fable 5.1'));
    expect(onModel).toHaveBeenCalledWith('fable');
    fireEvent.click(effort.getByText('엑스트라'));
    expect(onEffort).toHaveBeenCalledWith('xhigh');
  });

  it('auto engine: Claude and GPT sections with headers', () => {
    setup({ models: [...CLAUDE_MODELS, ...CODEX_MODELS], model: 'gpt-6-sol', effort: 'medium' });
    expect(screen.getByTestId('model-picker').textContent).toContain('GPT-6.1-Sol 중간');
    fireEvent.click(screen.getByTestId('model-picker'));
    const menu = within(screen.getByTestId('model-menu'));
    expect(menu.getByText('Claude')).toBeTruthy();
    expect(within(menu.getByRole('group', { name: 'GPT' })).getAllByRole('menuitemradio').map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra']);
  });

  it('자동: listed first, label without effort while effort is 자동, and an effort 자동 button reporting null', () => {
    const { onModel, onEffort } = setup({ models: ['auto', ...CLAUDE_MODELS], model: 'auto', effort: null });
    expect(screen.getByTestId('model-picker').textContent).toContain('자동');
    expect(screen.getByTestId('model-picker').textContent).not.toContain('·');
    fireEvent.click(screen.getByTestId('model-picker'));
    const menu = within(screen.getByTestId('model-menu'));
    const models = within(menu.getByRole('group', { name: 'Claude' })).getAllByRole('menuitemradio');
    expect(models.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['자동', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1']);
    const effort = within(menu.getByRole('group', { name: '추론 수준' }));
    expect(effort.getAllByRole('menuitemradio').map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([['자동', 'true'], ['낮음', 'false'], ['중간', 'false'], ['높음', 'false'], ['엑스트라', 'false']]);
    fireEvent.click(effort.getByText('낮음'));
    expect(onEffort).toHaveBeenCalledWith('low');
    fireEvent.click(effort.getByText('자동'));
    expect(onEffort).toHaveBeenLastCalledWith(null);
    fireEvent.click(menu.getByText('Opus 5.5'));
    expect(onModel).toHaveBeenCalledWith('opus');
  });

  it('closes on Escape and on a pointer down outside, not on one inside', () => {
    setup();
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.pointerDown(screen.getByTestId('model-menu'));
    expect(screen.getByTestId('model-menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('model-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('model-menu')).toBeNull();
  });

  it('keeps the popover inside the viewport (fixed position clamped to an 8px margin)', () => {
    const w = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    // Button hugging the left edge (narrow leftmost pane), popover wider than the button's right offset.
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { left: 10, right: 90, top: 600, bottom: 628, width: 80, height: 28, x: 10, y: 600, toJSON: () => ({}) } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 300 });
    try {
      setup();
      fireEvent.click(screen.getByTestId('model-picker'));
      const pop = screen.getByTestId('model-menu');
      expect(pop.style.left).toBe('8px');
      expect(pop.style.bottom).toBe(`${640 - 600 + 6}px`);
      expect(pop.style.maxHeight).toBe(`${600 - 6 - 8}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
      if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    }
  });
});
