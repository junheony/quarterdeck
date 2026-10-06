/** A command the composer's `/` menu offers (name without the slash). */
export type SlashCommandInfo = { name: string; description: string; argumentHint: string };

/** Offered before any Claude turn has reported its own list (headless-safe built-ins). */
export const DEFAULT_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: '대화를 요약해 컨텍스트를 줄입니다', argumentHint: '' },
  { name: 'init', description: 'CLAUDE.md 를 만듭니다', argumentHint: '' },
  { name: 'review', description: '변경 사항을 리뷰합니다', argumentHint: '' },
  { name: 'security-review', description: '보안 리뷰', argumentHint: '' },
];

const MAX_SESSIONS = 200;
const MAX_COMMANDS = 500;

/**
 * Slash commands as the Claude CLI reported them (system/init `slash_commands` minus `terminal_slash_commands`,
 * or a `commands_changed` push with descriptions), remembered per session and per cwd; the newest list is the
 * fallback for a session that has not run a turn in this server's lifetime.
 */
export class SlashCommandCache {
  private bySession = new Map<string, SlashCommandInfo[]>();
  private byCwd = new Map<string, SlashCommandInfo[]>();
  private latest: SlashCommandInfo[] | null = null;

  /** `commands`: plain names (init) or full entries (commands_changed); known descriptions are kept for plain names. */
  record(sessionId: string | null, cwd: string | null, commands: (string | SlashCommandInfo)[], terminal: string[] = []): void {
    const hide = new Set(terminal);
    const known = new Map((this.latest ?? []).map((c) => [c.name, c]));
    const seen = new Set<string>();
    const list: SlashCommandInfo[] = [];
    for (const c of commands) {
      const info = typeof c === 'string' ? (known.get(c) ?? { name: c, description: '', argumentHint: '' }) : c;
      const name = info.name.replace(/^\//, '');
      if (!name || hide.has(name) || seen.has(name)) continue;
      seen.add(name);
      list.push({ name, description: info.description ?? '', argumentHint: info.argumentHint ?? '' });
      if (list.length >= MAX_COMMANDS) break;
    }
    if (list.length === 0) return;
    this.latest = list;
    if (sessionId) { this.bySession.delete(sessionId); this.bySession.set(sessionId, list); }
    if (cwd) { this.byCwd.delete(cwd); this.byCwd.set(cwd, list); }
    if (this.bySession.size > MAX_SESSIONS) this.bySession.delete(this.bySession.keys().next().value!);
    if (this.byCwd.size > MAX_SESSIONS) this.byCwd.delete(this.byCwd.keys().next().value!);
  }

  get(sessionId: string | null, cwd: string | null): SlashCommandInfo[] {
    return (sessionId ? this.bySession.get(sessionId) : undefined) ?? (cwd ? this.byCwd.get(cwd) : undefined) ?? this.latest ?? DEFAULT_SLASH_COMMANDS;
  }
}
