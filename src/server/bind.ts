import { execFileSync } from 'node:child_process';
import type os from 'node:os';

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns (also used by carrier NAT, so not sufficient alone). */
export function isCgnat(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Tailscale's tunnel interface: `utunN` on macOS, `tailscaleN` on Linux. */
export function isTailscaleInterface(name: string): boolean {
  return /^(utun|tailscale)\d+$/.test(name);
}

const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** IPv4s from `tailscale ip -4`, or null when the CLI is missing/fails/prints nothing usable (fail soft). */
export function tailscaleIPv4s(
  run: () => string = () => runTailscale(['ip', '-4']),
): string[] | null {
  try {
    const ips = run().split(/\s+/).filter(isCgnat);
    return ips.length ? ips : null;
  } catch {
    return null;
  }
}

function runTailscale(args: string[]): string {
  let last: unknown;
  for (const bin of TAILSCALE_BINS) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * PWA: this node's MagicDNS name (`Self.DNSName` from `tailscale status --json`, trailing dot dropped),
 * or null (fail soft). Allowlisted as a Host so `tailscale serve` (https://<name>/ → 127.0.0.1) reaches deck.
 */
export function tailscaleDnsName(run: () => string = () => runTailscale(['status', '--json'])): string | null {
  try {
    const name = (JSON.parse(run()) as { Self?: { DNSName?: unknown } }).Self?.DNSName;
    if (typeof name !== 'string') return null;
    const host = name.replace(/\.$/, '').toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Spec §6: bind 127.0.0.1 and Tailscale addresses only. Never 0.0.0.0.
 * A 100.64/10 address counts only on a Tailscale tunnel interface; when `tailscaleIps`
 * (from `tailscaleIPv4s()`) is given, it must also be one of those.
 */
export function bindAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  opts: { loopbackOnly?: boolean; tailscaleIps?: string[] | null } = {},
): string[] {
  const out = ['127.0.0.1'];
  if (opts.loopbackOnly) return out;
  for (const [name, list] of Object.entries(ifaces)) {
    if (!isTailscaleInterface(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal || !isCgnat(info.address) || out.includes(info.address)) continue;
      if (opts.tailscaleIps && !opts.tailscaleIps.includes(info.address)) continue;
      out.push(info.address);
    }
  }
  return out;
}
