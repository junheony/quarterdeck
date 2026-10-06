import { describe, expect, it } from 'vitest';
import type os from 'node:os';
import { bindAddresses, isCgnat, isTailscaleInterface, tailscaleDnsName, tailscaleIPv4s } from './bind';

function v4(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/32` };
}

describe('isCgnat', () => {
  it('matches 100.64.0.0/10 only', () => {
    expect(isCgnat('100.64.0.0')).toBe(true);
    expect(isCgnat('100.64.0.1')).toBe(true);
    expect(isCgnat('100.127.255.255')).toBe(true);
    expect(isCgnat('100.128.0.0')).toBe(false);
    expect(isCgnat('100.63.255.255')).toBe(false);
    expect(isCgnat('192.168.1.2')).toBe(false);
    expect(isCgnat('not-an-ip')).toBe(false);
  });
});

describe('bindAddresses', () => {
  it('returns loopback plus tailscale addresses and nothing else', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.0.10')],
      utun4: [v4('100.64.0.1')],
      utun5: [{ ...v4('fd7a::1'), family: 'IPv6' as const, scopeid: 0 }],
    };
    expect(bindAddresses(ifaces)).toEqual(['127.0.0.1', '100.64.0.1']);
  });

  it('returns only loopback when no tailscale interface exists or loopbackOnly is set', () => {
    expect(bindAddresses({ en0: [v4('192.168.0.10')] })).toEqual(['127.0.0.1']);
    expect(bindAddresses({ utun4: [v4('100.64.0.1')] }, { loopbackOnly: true })).toEqual(['127.0.0.1']);
  });
});

describe('bindAddresses — carrier NAT is not Tailscale', () => {
  it('rejects 100.64/10 on a non-tunnel interface (ISP / Starlink CGNAT on en0)', () => {
    expect(bindAddresses({ en0: [v4('100.72.1.2')] })).toEqual(['127.0.0.1']);
    expect(bindAddresses({ en0: [v4('100.72.1.2')], utun3: [v4('100.64.0.1')] })).toEqual(['127.0.0.1', '100.64.0.1']);
  });

  it('accepts 100.64/10 on utunN / tailscaleN only', () => {
    expect(isTailscaleInterface('utun0')).toBe(true);
    expect(isTailscaleInterface('utun12')).toBe(true);
    expect(isTailscaleInterface('tailscale0')).toBe(true);
    expect(isTailscaleInterface('en0')).toBe(false);
    expect(isTailscaleInterface('bridge100')).toBe(false);
    expect(bindAddresses({ utun7: [v4('100.64.0.9')] })).toEqual(['127.0.0.1', '100.64.0.9']);
  });

  it('intersects with `tailscale ip -4` when it is known', () => {
    const ifaces = { utun3: [v4('100.64.0.1')], utun4: [v4('100.100.1.1')] };
    expect(bindAddresses(ifaces, { tailscaleIps: ['100.64.0.1'] })).toEqual(['127.0.0.1', '100.64.0.1']);
    expect(bindAddresses(ifaces, { tailscaleIps: null })).toEqual(['127.0.0.1', '100.64.0.1', '100.100.1.1']);
  });

  it('tailscaleIPv4s fails soft', () => {
    expect(tailscaleIPv4s(() => { throw new Error('ENOENT'); })).toBeNull();
    expect(tailscaleIPv4s(() => '100.64.0.1\n')).toEqual(['100.64.0.1']);
    expect(tailscaleIPv4s(() => 'garbage\n')).toBeNull();
  });
});

describe('tailscaleDnsName', () => {
  it('reads Self.DNSName without the trailing dot', () => {
    expect(tailscaleDnsName(() => JSON.stringify({ Self: { DNSName: 'Deck-Host.example.ts.net.' } }))).toBe('deck-host.example.ts.net');
  });

  it('fails soft on missing CLI, bad JSON or a missing/odd name', () => {
    expect(tailscaleDnsName(() => { throw new Error('ENOENT'); })).toBeNull();
    expect(tailscaleDnsName(() => 'not json')).toBeNull();
    expect(tailscaleDnsName(() => JSON.stringify({ Self: {} }))).toBeNull();
    expect(tailscaleDnsName(() => JSON.stringify({ Self: { DNSName: '' } }))).toBeNull();
    expect(tailscaleDnsName(() => JSON.stringify({ Self: { DNSName: 'evil host/x' } }))).toBeNull();
  });
});
