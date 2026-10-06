import { describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../shared/session-types';
import { findSession, isIos, pushBlocker, urlB64ToBytes } from './push';

const fakeWin = (o: { secure: boolean; ua: string; touch?: number; standalone?: boolean; push?: boolean }) => ({
  isSecureContext: o.secure,
  navigator: { userAgent: o.ua, maxTouchPoints: o.touch ?? 0, standalone: o.standalone, ...(o.push === false ? {} : { serviceWorker: {} }) },
  matchMedia: () => ({ matches: o.standalone === true }),
  ...(o.push === false ? {} : { PushManager: function PushManager() {}, Notification: function Notification() {} }),
}) as unknown as Window;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

describe('pushBlocker', () => {
  it('plain http over the tailnet → needs https', () => {
    expect(pushBlocker(fakeWin({ secure: false, ua: MAC }))).toBe('insecure');
  });
  it('iPhone Safari tab → install to home screen first; the installed app is fine', () => {
    expect(pushBlocker(fakeWin({ secure: true, ua: IPHONE }))).toBe('ios-install');
    expect(pushBlocker(fakeWin({ secure: true, ua: IPHONE, standalone: true }))).toBeNull();
  });
  it('desktop browser with the Push API → ok; without → unsupported', () => {
    expect(pushBlocker(fakeWin({ secure: true, ua: MAC }))).toBeNull();
    expect(pushBlocker(fakeWin({ secure: true, ua: MAC, push: false }))).toBe('unsupported');
  });
  it('iPadOS (Mac UA + touch) counts as iOS', () => {
    expect(isIos({ userAgent: MAC, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false);
  });
});

describe('urlB64ToBytes', () => {
  it('decodes base64url without padding', () => {
    expect([...urlB64ToBytes('_-8')]).toEqual([0xff, 0xef]);
    expect([...urlB64ToBytes('AQID')]).toEqual([1, 2, 3]);
  });
});

describe('findSession', () => {
  const projects = [{ cwd: '/p', name: 'p', pinned: false, sessions: [{ sessionId: 's1', account: 'b', cwd: '/p', projectDir: '/x', file: '/x/s1.jsonl', title: 'T1', lastModified: 0, sizeBytes: 0 }] }] as ProjectEntry[];
  it('finds listed sessions, then Desktop ones, else null', () => {
    expect(findSession(projects, [], 's1')).toEqual({ cwd: '/p', title: 'T1' });
    expect(findSession(projects, [{ sessionId: 'd1', account: 'a', title: 'D', cwd: '/d', project: 'd', lastModified: 0 }], 'd1')).toEqual({ cwd: '/d', title: 'D' });
    expect(findSession(projects, [], 'nope')).toBeNull();
  });
});
