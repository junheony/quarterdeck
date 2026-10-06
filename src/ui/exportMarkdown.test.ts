import { describe, expect, it } from 'vitest';
import { conversationMarkdown, exportFileName } from './exportMarkdown';
import type { ChatItem } from './state';

const date = new Date(2026, 9, 2, 9, 5);

describe('conversationMarkdown', () => {
  it('title, folder and date, user/assistant headings, tool calls summarised, injected notices dropped', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: '<command-name>/clear</command-name>' },
      { kind: 'user', text: '파일 세어줘', attachments: [{ id: 'a', name: 'shot.png', isImage: true }] },
      { kind: 'assistant', turnId: 't', text: '**3개**입니다.', toolCalls: [{ toolUseId: 'u1', name: 'Bash', input: { command: 'ls | wc -l' }, result: '3', isError: false }], badge: null, streaming: false, error: null, notes: [], attempts: [] },
    ];
    const md = conversationMarkdown({ title: '세기', items, cwd: '/w/deck', date });
    expect(md.startsWith('# 세기\n\n_/w/deck · 2026-10-02 09:05_\n')).toBe(true);
    expect(md).not.toContain('/clear');
    expect(md).toContain('## 사용자\n\n파일 세어줘\n\n📎 shot.png');
    expect(md).toMatch(/## Claude\n\n- 🔧 .+\n\n\*\*3개\*\*입니다\./);
    expect(md.indexOf('## 사용자')).toBeLessThan(md.indexOf('## Claude'));
  });

  it('assistant label and errors', () => {
    const md = conversationMarkdown({ title: '', items: [{ kind: 'assistant', turnId: null, text: '', toolCalls: [], badge: null, streaming: false, error: '한도', notes: [], attempts: [] }], date, assistant: 'GPT' });
    expect(md).toContain('# 대화');
    expect(md).toContain('## GPT\n\n> 오류: 한도');
  });

  it('file name strips path characters and adds the date', () => {
    expect(exportFileName('a/b: c?', date)).toBe('a b c 2026-10-02.md');
    expect(exportFileName('', date)).toBe('대화 2026-10-02.md');
  });
});
