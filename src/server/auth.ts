import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const COOKIE_NAME = 'deck_session';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export async function loadOrCreateToken(file: string): Promise<string> {
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // fall through: create
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const token = randomBytes(32).toString('hex');
  await fs.writeFile(file, token + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return token;
}

/**
 * The browser never holds the login token itself, only this derived value.
 * Deliberate for now (review M6): the cookie is a fixed function of the token and is not
 * rotated per login; rotating the token file is what invalidates every session.
 */
export function cookieValueFor(token: string): string {
  return createHash('sha256').update(`deck-cookie:${token}`).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = safeDecode(v);
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function isAuthed(cookieHeader: string | undefined, token: string): boolean {
  const v = parseCookies(cookieHeader)[COOKIE_NAME];
  return typeof v === 'string' && safeEqual(v, cookieValueFor(token));
}

export function tokenMatches(candidate: string, token: string): boolean {
  return safeEqual(candidate.trim(), token);
}

/** PWA: `secure` when the request came through the HTTPS front (tailscale serve) — the cookie then never rides plain http. */
export function loginCookieHeader(token: string, secure = false): string {
  return `${COOKIE_NAME}=${cookieValueFor(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

export function logoutCookieHeader(secure = false): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Deviation (added per review I5): `SameSite=Strict` does not separate ports, so
 * any other local server on 127.0.0.1:<other-port> is still "same-site" and the
 * browser will attach our cookie to it. Origin comparisons already pin the exact
 * port (see below), but a Host allowlist adds defence-in-depth against DNS
 * rebinding, where an attacker's page (e.g. evil.example) resolves to 127.0.0.1
 * and the browser's same-origin check on the *attacker's own* origin would
 * otherwise pass. Checks only the hostname — the attacker fully controls the
 * name, but not which port reaches our listener.
 */
function hostnameOf(hostHeader: string): string {
  const bracketed = /^\[(.+)\]:\d+$/.exec(hostHeader) ?? /^\[(.+)\]$/.exec(hostHeader);
  if (bracketed) return bracketed[1]!;
  const i = hostHeader.lastIndexOf(':');
  return i >= 0 ? hostHeader.slice(0, i) : hostHeader;
}

/** Accepted: loopback and localhost, plus `extraHosts` (main passes the bound addresses and DECK_EXTRA_HOSTS). */
export function isAllowedHost(hostHeader: string | undefined, extraHosts: string[] = []): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader).toLowerCase();
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
  return extraHosts.some((h) => h.toLowerCase() === hostname);
}

/**
 * Origin === this server's own origin (host:port equal to the Host header) or one of `extraOrigins`.
 * PWA: scheme https is accepted too — `tailscale serve` terminates TLS for the MagicDNS name and
 * proxies to 127.0.0.1 with the same Host (no port). The Host itself is still allowlisted separately.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined, extraOrigins: string[] = []): boolean {
  if (!origin) return false;
  if (extraOrigins.includes(origin)) return true;
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

export type UpgradeCheck = { ok: true } | { ok: false; reason: string };

/**
 * WebSocket upgrade gate (spec §6): the Host must be one deck itself binds to
 * (or an allowed extra host), the session cookie must validate, and the
 * Origin must be this server itself (scheme http or https, host:port equal to the Host
 * header) or one of `extraOrigins` (Vite dev server).
 */
export function checkUpgrade(
  req: { headers: { cookie?: string; origin?: string; host?: string } },
  token: string,
  extraOrigins: string[] = [],
  extraHosts: string[] = [],
): UpgradeCheck {
  if (!isAllowedHost(req.headers.host, extraHosts)) return { ok: false, reason: `host ${req.headers.host ?? ''} not allowed` };
  if (!isAuthed(req.headers.cookie, token)) return { ok: false, reason: 'unauthenticated' };
  if (isAllowedOrigin(req.headers.origin, req.headers.host, extraOrigins)) return { ok: true };
  return { ok: false, reason: `origin ${req.headers.origin ?? '(none)'} not allowed` };
}
