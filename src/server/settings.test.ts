import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from './settings';

describe('SettingsStore', () => {
  it('defaults to asking (자동 승인 off); persists a change; a corrupt file falls back to defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'sub', 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance' });
    expect(await s.set({ autoApprove: true })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().autoApprove).toBe(true);
    await fs.writeFile(file, '{oops');
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance' });
  });

  it('an existing settings.json wins over the defaults: an install that chose 모두 자동 승인 keeps it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    for (const saved of [
      { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' },
      { autoApprove: true, defaultPermissionMode: 'bypassPermissions' },
      { defaultPermissionMode: 'bypassPermissions' },
      { autoApprove: true },
    ]) {
      await fs.writeFile(file, JSON.stringify(saved));
      const s = new SettingsStore(file);
      await s.load();
      expect(s.get()).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' });
    }
    // Only the fields the file lacks come from the defaults.
    await fs.writeFile(file, JSON.stringify({ routingPolicy: 'drain' }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain' });
  });

  it('migrates a legacy autoApprove-only file; defaultPermissionMode wins and keeps autoApprove in step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ autoApprove: false }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance' });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true }));
    await s.load();
    expect(s.get().defaultPermissionMode).toBe('bypassPermissions');
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance' });
    expect(await s.set({ defaultPermissionMode: 'bypassPermissions' })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance' }));
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance' });
  });

  it('routingPolicy: defaults to balance, round-trips drain through the file, ignores junk, survives other changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get().routingPolicy).toBe('balance');
    expect(await s.set({ routingPolicy: 'drain' })).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain' });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).routingPolicy).toBe('drain');
    // Another setting changed later keeps the policy.
    expect((await s.set({ defaultPermissionMode: 'plan' })).routingPolicy).toBe('drain');
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain' });
    // And the policy change keeps the permission mode.
    expect(await again.set({ routingPolicy: 'balance' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance' });
    await fs.writeFile(file, JSON.stringify({ defaultPermissionMode: 'plan', routingPolicy: 'spread-evenly' }));
    await again.load();
    expect(again.get().routingPolicy).toBe('balance');
  });
});
