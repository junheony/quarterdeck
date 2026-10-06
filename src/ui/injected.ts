/**
 * Claude Code injects harness messages into the transcript as *user* turns: background task
 * notifications (`<task-notification>…`), reminders (`<system-reminder>…`), slash-command echoes, etc.
 * Shown raw they look like a huge user bubble full of XML. This splits such a turn into the text the
 * person actually typed plus compact notices the chat renders as muted system lines.
 */

export type InjectedNotice = {
  kind: 'task' | 'command' | 'output' | 'hook';
  /** Short one-line label, e.g. "백그라운드 작업 완료". */
  label: string;
  /** Optional one-line detail after the label (task summary, command name). */
  summary: string;
  /** For tasks: completed | failed | killed | … (lowercase), else ''. */
  status: string;
  /** Longer body worth showing when expanded (task <result>, command output). */
  body: string;
  /** The original block, verbatim, for the expanded "raw" view. */
  raw: string;
};

export type ParsedUserText = { text: string; notices: InjectedNotice[] };

/** Blocks dropped from display entirely — context for the model, noise for the reader. */
const HIDDEN_TAGS = ['system-reminder', 'local-command-caveat'] as const;
/** Slash-command echo parts, merged into one "command" notice. */
const COMMAND_TAGS = ['command-name', 'command-message', 'command-args'] as const;
const OUTPUT_TAGS = ['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr'] as const;
const HOOK_TAGS = ['user-prompt-submit-hook'] as const;

function inner(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1]!.trim() : '';
}

function oneLine(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const TASK_LABEL: Record<string, string> = {
  completed: '백그라운드 작업 완료',
  failed: '백그라운드 작업 실패',
  killed: '백그라운드 작업 중단됨',
  stopped: '백그라운드 작업 중단됨',
  running: '백그라운드 작업 진행 중',
};

function taskNotice(raw: string): InjectedNotice {
  const status = inner(raw, 'status').toLowerCase();
  const summary = oneLine(inner(raw, 'summary'));
  const result = inner(raw, 'result');
  return { kind: 'task', label: TASK_LABEL[status] ?? '백그라운드 작업 알림', summary, status, body: result, raw };
}

const BLOCK = (tags: readonly string[]) => new RegExp(`<(${tags.join('|')})>[\\s\\S]*?</\\1>`, 'g');

/** Quick check so ordinary turns skip the regex work. */
export function hasInjected(text: string): boolean {
  return /<(task-notification|system-reminder|local-command-|command-name|command-message|command-args|bash-std|user-prompt-submit-hook)/.test(text);
}

export function parseUserText(text: string): ParsedUserText {
  if (!hasInjected(text)) return { text, notices: [] };
  const found: InjectedNotice[] = [];
  let rest = text;

  rest = rest.replace(BLOCK(HIDDEN_TAGS), '');

  rest = rest.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, (raw) => {
    found.push(taskNotice(raw));
    return '';
  });

  // A slash-command echo is several sibling tags; fold them into one notice.
  const cmd: Record<string, string> = {};
  const cmdRaw: string[] = [];
  rest = rest.replace(BLOCK(COMMAND_TAGS), (raw, tag: string) => {
    cmd[tag] = inner(raw, tag);
    cmdRaw.push(raw);
    return '';
  });
  if (cmdRaw.length) {
    const name = cmd['command-name'] || (cmd['command-message'] ? `/${cmd['command-message']}` : '명령');
    const args = cmd['command-args'] ?? '';
    found.push({ kind: 'command', label: '명령 실행', summary: oneLine(args ? `${name} ${args}` : name), status: '', body: '', raw: cmdRaw.join('\n') });
  }

  rest = rest.replace(BLOCK(OUTPUT_TAGS), (raw, tag: string) => {
    const body = inner(raw, tag);
    if (body) found.push({ kind: 'output', label: tag.endsWith('stderr') ? '명령 오류 출력' : '명령 출력', summary: oneLine(body, 90), status: '', body, raw });
    return '';
  });

  rest = rest.replace(BLOCK(HOOK_TAGS), (raw, tag: string) => {
    const body = inner(raw, tag);
    found.push({ kind: 'hook', label: '훅 메시지', summary: oneLine(body, 90), status: '', body, raw });
    return '';
  });

  // Order is by kind (tasks, command, output, hook); a turn rarely mixes kinds.
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), notices: found };
}
