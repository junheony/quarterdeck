import type { ChatItem } from './state';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

/** An assistant item that carries nothing but tool calls (transcripts store one per tool-use message). */
function toolOnly(it: ChatItem): it is Assistant {
  return it.kind === 'assistant' && it.toolCalls.length > 0 && it.text === '' && it.error === null && it.badge === null && it.notes.length === 0 && it.attempts.length === 0;
}

/**
 * Display-only: consecutive tool-only assistant items fold into the next assistant item, so a run of
 * tool calls renders as ONE line ("실행된 명령 5개 ›") followed by the text that came after it (Desktop style).
 */
export function mergeToolRuns(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (it.kind === 'assistant' && prev && toolOnly(prev)) {
      out[out.length - 1] = { ...it, toolCalls: [...prev.toolCalls, ...it.toolCalls], streaming: it.streaming || prev.streaming };
    } else {
      out.push(it);
    }
  }
  return out;
}
