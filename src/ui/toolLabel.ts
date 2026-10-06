import type { ToolCallItem } from './state';

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const clip = (s: string, n = 64) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null);

/** One muted line per tool call, Desktop style: a verb plus the thing it touched. */
export function toolLabel(call: ToolCallItem): string {
  const i = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const file = str(i, 'file_path') ?? str(i, 'path') ?? str(i, 'notebook_path');
  switch (call.name) {
    case 'Bash': return str(i, 'description') ? clip(str(i, 'description')!) : `명령 실행 ${clip(str(i, 'command') ?? '', 48)}`.trim();
    case 'Read': return file ? `${base(file)} 읽음` : '파일 읽음';
    case 'Edit': case 'MultiEdit': return file ? `${base(file)} 수정함` : '파일 수정함';
    case 'Write': return file ? `${base(file)} 작성함` : '파일 작성함';
    case 'NotebookEdit': return file ? `${base(file)} 노트북 수정함` : '노트북 수정함';
    case 'Grep': return `"${clip(str(i, 'pattern') ?? '', 40)}" 검색함`;
    case 'Glob': return `${clip(str(i, 'pattern') ?? '', 40)} 찾음`;
    case 'Agent': case 'Task': return `서브에이전트 · ${clip(str(i, 'description') ?? str(i, 'subagent_type') ?? '작업', 48)}`;
    case 'WebFetch': return `${clip(str(i, 'url') ?? '', 48)} 가져옴`;
    case 'WebSearch': return `"${clip(str(i, 'query') ?? '', 40)}" 웹 검색`;
    case 'TodoWrite': return '할 일 목록 갱신';
    case 'Skill': return `스킬 ${str(i, 'skill') ?? ''}`.trim();
    default: return call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name;
  }
}

/** Label for a run of consecutive calls (Desktop: "실행된 명령 5개"). */
export function groupLabel(calls: ToolCallItem[]): string {
  if (calls.every((c) => c.name === 'Bash')) return `실행된 명령 ${calls.length}개`;
  if (calls.every((c) => c.name === 'Read')) return `읽은 파일 ${calls.length}개`;
  if (calls.every((c) => c.name === 'Edit' || c.name === 'MultiEdit' || c.name === 'Write')) return `수정한 파일 ${calls.length}개`;
  if (calls.every((c) => c.name === 'Grep' || c.name === 'Glob')) return `검색 ${calls.length}회`;
  return `도구 호출 ${calls.length}개`;
}
