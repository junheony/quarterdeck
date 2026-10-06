// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ClaudeMark, EngineMark } from './EngineMark';

afterEach(cleanup);

describe('ClaudeMark', () => {
  it('is an SVG star in #D97757 with no text (a ✳ glyph renders as a green emoji on some systems)', () => {
    const { container } = render(<><EngineMark engine="claude" /><ClaudeMark className="spark" /></>);
    const marks = container.querySelectorAll('svg.claude-mark');
    expect(marks).toHaveLength(2);
    expect(container.querySelector('.engine-mark.claude svg.engine-mark-svg')).not.toBeNull();
    for (const m of marks) {
      expect(m.querySelectorAll('line').length).toBeGreaterThanOrEqual(8);
      expect(m.querySelector('g')?.getAttribute('stroke')).toBe('#D97757');
    }
    expect(container.textContent).toBe('');
  });
});
