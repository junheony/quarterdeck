import type { ToolCallItem } from './state';

/** D9: who did the work in this turn besides the main model. */
export type RoleEntry =
  | { kind: 'agent'; type: string; model: string | null; description: string }
  | { kind: 'offload'; model: string | null; cross: boolean; command: string };

const OFFLOAD = /^(?:\S*\/)?offload\b([\s\S]*)$/;

export function roleSummary(toolCalls: ToolCallItem[]): RoleEntry[] {
  const out: RoleEntry[] = [];
  for (const c of toolCalls) {
    const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {};
    if (c.name === 'Agent' || c.name === 'Task') {
      out.push({
        kind: 'agent',
        type: typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general',
        model: typeof input.model === 'string' ? input.model : null,
        description: typeof input.description === 'string' ? input.description : '',
      });
    } else if (c.name === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command.trim();
      const m = OFFLOAD.exec(cmd);
      if (!m) continue;
      const rest = (m[1] ?? '').trim();
      if (/^status\b/.test(rest)) continue;
      const model = /(?:^|\s)(?:-m|--model)[=\s]+(\S+)/.exec(rest)?.[1] ?? null;
      out.push({ kind: 'offload', model, cross: /^cross\b/.test(rest), command: cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd });
    }
  }
  return out;
}
