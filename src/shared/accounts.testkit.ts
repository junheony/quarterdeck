import { buildRegistry, defaultAccountsConfig, type AccountRegistry, type AccountRoot } from './accounts';

/** Tests only: the a/b/c registry (`~/.claude`, `~/.claude-b`, `~/.claude-c` under `homeDir`), passed explicitly wherever production code takes one. */
export function testRegistry(homeDir = '/h'): AccountRegistry {
  return buildRegistry(defaultAccountsConfig(['.claude', '.claude-b', '.claude-c']), { homeDir });
}

/** Tests only: an id → dir object as the ordered list the session readers take (key order = account order). */
export function rootsOf(dirs: Record<string, string>): AccountRoot[] {
  return Object.entries(dirs).map(([id, dir]) => ({ id, dir }));
}
