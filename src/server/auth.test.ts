import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COOKIE_NAME,
  checkUpgrade,
  isAllowedHost,
  cookieValueFor,
  isAuthed,
  loadOrCreateToken,
  loginCookieHeader,
  logoutCookieHeader,
  parseCookies,
} from './auth';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'deck-auth-'));
}

describe('token file', () => {
  it('creates a 64-hex token with mode 0600 in a 0700 dir and reuses it', async () => {
    const dir = path.join(await tmp(), 'cfg');
    const file = path.join(dir, 'token');
    const t1 = await loadOrCreateToken(file);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const t2 = await loadOrCreateToken(file);
    expect(t2).toBe(t1);
  });
});

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; deck_session=abc; b=x%20y')).toEqual({ a: '1', deck_session: 'abc', b: 'x y' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('authenticates only the derived cookie value, never the raw token', () => {
    const token = 'f'.repeat(64);
    expect(isAuthed(`${COOKIE_NAME}=${cookieValueFor(token)}`, token)).toBe(true);
    expect(isAuthed(`${COOKIE_NAME}=${token}`, token)).toBe(false);
    expect(isAuthed(`${COOKIE_NAME}=${cookieValueFor('0'.repeat(64))}`, token)).toBe(false);
    expect(isAuthed(undefined, token)).toBe(false);
  });

  it('login cookie is HttpOnly, SameSite=Strict, Path=/', () => {
    const h = loginCookieHeader('f'.repeat(64));
    expect(h).toContain(`${COOKIE_NAME}=${cookieValueFor('f'.repeat(64))}`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Strict');
    expect(h).toContain('Path=/');
    expect(logoutCookieHeader()).toContain('Max-Age=0');
    expect(h).not.toContain('Secure');
  });

  it('adds Secure only when served over https', () => {
    expect(loginCookieHeader('f'.repeat(64), true)).toMatch(/; Secure$/);
    expect(logoutCookieHeader(true)).toMatch(/; Secure$/);
  });
});

describe('checkUpgrade', () => {
  const token = 'a'.repeat(64);
  const cookie = `${COOKIE_NAME}=${cookieValueFor(token)}`;

  it('accepts cookie + Origin matching Host', () => {
    expect(checkUpgrade({ headers: { cookie, origin: 'http://127.0.0.1:9320', host: '127.0.0.1:9320' } }, token)).toEqual({ ok: true });
  });

  it('rejects a missing or wrong cookie', () => {
    expect(checkUpgrade({ headers: { origin: 'http://127.0.0.1:9320', host: '127.0.0.1:9320' } }, token).ok).toBe(false);
    expect(checkUpgrade({ headers: { cookie: `${COOKIE_NAME}=nope`, origin: 'http://127.0.0.1:9320', host: '127.0.0.1:9320' } }, token).ok).toBe(false);
  });

  it('rejects a missing or foreign Origin', () => {
    expect(checkUpgrade({ headers: { cookie, host: '127.0.0.1:9320' } }, token).ok).toBe(false);
    expect(checkUpgrade({ headers: { cookie, origin: 'http://evil.example', host: '127.0.0.1:9320' } }, token).ok).toBe(false);
    expect(checkUpgrade({ headers: { cookie, origin: 'http://127.0.0.1:9999', host: '127.0.0.1:9320' } }, token).ok).toBe(false);
  });

  // PWA: tailscale serve fronts deck at https://<magicdns> (no port) and forwards that Host unchanged.
  it('accepts the https MagicDNS origin (no port) when its Host is allowlisted', () => {
    const host = 'deck-host.example.ts.net';
    expect(checkUpgrade({ headers: { cookie, origin: `https://${host}`, host } }, token, [], [host])).toEqual({ ok: true });
    expect(checkUpgrade({ headers: { cookie, origin: `https://${host}`, host } }, token).ok).toBe(false);
    expect(checkUpgrade({ headers: { cookie, origin: 'https://evil.example', host } }, token, [], [host]).ok).toBe(false);
    expect(checkUpgrade({ headers: { cookie, origin: `https://${host}:8443`, host } }, token, [], [host]).ok).toBe(false);
  });

  it('accepts an explicitly allowed dev origin', () => {
    const r = checkUpgrade({ headers: { cookie, origin: 'http://localhost:5173', host: '127.0.0.1:9320' } }, token, ['http://localhost:5173']);
    expect(r).toEqual({ ok: true });
  });
});

describe('isAllowedHost', () => {
  it('accepts loopback, localhost and the explicitly listed (bound) hosts only', () => {
    expect(isAllowedHost('127.0.0.1:9320')).toBe(true);
    expect(isAllowedHost('localhost:9320')).toBe(true);
    expect(isAllowedHost('[::1]:9320')).toBe(true);
    expect(isAllowedHost('100.64.0.1:9320', ['100.64.0.1'])).toBe(true);
    expect(isAllowedHost('deck.tail.ts.net:9320', ['deck.tail.ts.net'])).toBe(true);
  });

  it('rejects an arbitrary 100.64/10 host that deck does not bind to', () => {
    expect(isAllowedHost('100.72.1.2:9320')).toBe(false);
    expect(isAllowedHost('100.72.1.2:9320', ['100.64.0.1'])).toBe(false);
    expect(isAllowedHost('evil.example:9320')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});
