import { parseUserText } from './injected';
import type { ChatItem } from './state';
import { toolLabel } from './toolLabel';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local "YYYY-MM-DD HH:mm". */
export function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The visible conversation as one markdown document: title, folder and date, then one heading per
 * user/assistant message. Harness-injected notices are dropped; tool calls become one summary line each.
 */
export function conversationMarkdown(o: { title: string; items: ChatItem[]; cwd?: string; date: Date; assistant?: string }): string {
  const who = o.assistant ?? 'Claude';
  const out: string[] = [`# ${o.title || '대화'}`, '', `_${[o.cwd, stamp(o.date)].filter(Boolean).join(' · ')}_`];
  for (const it of o.items) {
    if (it.kind === 'user') {
      const { text } = parseUserText(it.text);
      const files = (it.attachments ?? []).map((f) => `📎 ${f.name}`);
      if (!text && !files.length) continue;
      out.push('', '## 사용자', '', ...(text ? [text] : []), ...(files.length ? ['', files.join(' · ')] : []));
      continue;
    }
    if (it.kind === 'system') continue;
    const tools = it.toolCalls.map((c) => `- 🔧 ${toolLabel(c)}${c.isError ? ' (오류)' : ''}`);
    if (!it.text && !tools.length && !it.error) continue;
    out.push('', `## ${who}`);
    if (tools.length) out.push('', ...tools);
    if (it.text) out.push('', it.text);
    if (it.error) out.push('', `> 오류: ${it.error}`);
  }
  return out.join('\n') + '\n';
}

/** A safe download name: the title without path/reserved characters, plus the date. */
export function exportFileName(title: string, date: Date): string {
  const base = (title || '대화').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '대화';
  return `${base} ${stamp(date).slice(0, 10)}.md`;
}
