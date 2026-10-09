import { describe, expect, it } from 'vitest';
import { openRequestStep } from './openRequest';

const a = [{}] as unknown[];
const b = [{}] as unknown[];

describe('openRequestStep (a notification tap)', () => {
  it('opens a session that is there', () => {
    expect(openRequestStep({ found: true, projects: a, missedIn: null })).toBe('done');
    expect(openRequestStep({ found: true, projects: b, missedIn: a })).toBe('done');
  });
  it('waits for the first index', () => {
    expect(openRequestStep({ found: false, projects: [], missedIn: null })).toBe('wait');
  });
  it('not in the index yet: waits for the next one, then gives up', () => {
    expect(openRequestStep({ found: false, projects: a, missedIn: null })).toBe('miss');
    // The same index again (a re-render): still waiting.
    expect(openRequestStep({ found: false, projects: a, missedIn: a })).toBe('wait');
    expect(openRequestStep({ found: false, projects: b, missedIn: a })).toBe('fail');
  });
});
