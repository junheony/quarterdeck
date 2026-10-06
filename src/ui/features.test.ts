import { afterEach, describe, expect, it } from 'vitest';
import { has, setFeatures } from './features';

afterEach(() => setFeatures(undefined));

describe('features', () => {
  it('an older server (no list in hello) has none', () => {
    expect(has('catchup')).toBe(false);
    setFeatures(undefined);
    expect(has('sessionModel')).toBe(false);
  });

  it('has() answers from the last hello; names this build does not know are ignored', () => {
    setFeatures(['catchup', 'somethingNewer']);
    expect(has('catchup')).toBe(true);
    expect(has('sessionModel')).toBe(false);
    // A reconnect to an older server: nothing again.
    setFeatures(undefined);
    expect(has('catchup')).toBe(false);
  });

  it('a malformed list is no list', () => {
    setFeatures({ catchup: true } as never);
    expect(has('catchup')).toBe(false);
    setFeatures([1, null, 'catchup'] as never);
    expect(has('catchup')).toBe(true);
  });
});
