import { describe, expect, it } from 'vitest';
import { parseIsoUtc } from './usage-types';

describe('parseIsoUtc', () => {
  it('treats a zone-less date-time as UTC, like claude-pick', () => {
    const utc = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(parseIsoUtc('2026-09-30T12:00:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30 12:00:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T12:00:00.000Z')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T21:00:00+09:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T21:00:00+0900')).toBe(utc);
    expect(parseIsoUtc('2026-09-30')).toBe(Date.UTC(2026, 8, 30));
    expect(parseIsoUtc('nope')).toBeNaN();
  });
});
